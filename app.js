"use strict";
// @ts-check

/* ═══════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════ */
const SUPABASE_URL = "https://hinpdwtirothqblgnyqe.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpbnBkd3Rpcm90aHFibGdueXFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NTY3MjAsImV4cCI6MjA4ODMzMjcyMH0.YHlzyJCegpQHuKQ6SRnSL_8IdlwPlQyG3x2WoaAvF14";

/* ═══════════════════════════════════════════════════════
   SUPABASE CLIENT
   ═══════════════════════════════════════════════════════ */
// Loaded via <script> tag from supabase-js CDN or self-hosted copy.
// window.supabase is the UMD global.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ═══════════════════════════════════════════════════════
   HELPERS (unchanged from original)
   ═══════════════════════════════════════════════════════ */
const sanitize = (function () {
  const RE = /[^a-zA-Z0-9\u00C0-\u024F '\-.]/g;
  return function (s) {
    return String(s || "")
      .trim()
      .replace(RE, "")
      .substring(0, 50);
  };
})();

function clampInt(v, lo, hi) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const att of Object.keys(attrs)) {
      if (att === "textContent" || att === "className") node[att] = attrs[att];
      else node.setAttribute(att, attrs[att]);
    }
  }
  if (children) {
    for (const ch of children) {
      if (typeof ch === "string") node.appendChild(document.createTextNode(ch));
      else if (ch) node.appendChild(ch);
    }
  }
  return node;
}

/* ═══════════════════════════════════════════════════════
   MODEL — thin local cache, Supabase is source of truth
   ═══════════════════════════════════════════════════════

   The Model no longer validates or mutates.  It holds a
   local cache of the latest server state plus transient
   UI-only fields (selectedPlayers, editingMatch, errors,
   session).  Writes go through Actions → Supabase; the
   Realtime subscription pushes updates back here.
   ═══════════════════════════════════════════════════════ */
const Model = (function () {
  const dataset = {
    players: [],
    matches: [],
    /* UI-only (never persisted) */
    selectedPlayers: new Map(),
    editingMatch: null,
    errors: { player: "", match: "" },
    session: null,
  };

  return {
    /** Hydrate from Supabase — called once on boot and
     *  on every Realtime event */
    hydrate: async function () {
      const [pRes, mRes] = await Promise.all([
        sb.from("players").select("*").order("surname").order("name"),
        sb.from("match_details").select("*"),
      ]);

      if (pRes.error) {
        console.error("Players fetch error:", pRes.error);
        return;
      }
      if (mRes.error) {
        console.error("Matches fetch error:", mRes.error);
        return;
      }

      dataset.players = pRes.data;

      /* match_details view returns home/away as jsonb —
         map the column names to the shape State expects */
      dataset.matches = mRes.data.map(function (m) {
        return {
          id: m.id,
          round: m.round,
          home: m.home,
          away: m.away,
          hScore: m.h_score,
          aScore: m.a_score,
        };
      });

      State.render(Model.snapshot());
    },

    /** Patch transient UI fields and re-render */
    patch: function (partial) {
      if (partial.errors) {
        dataset.errors = {
          player: partial.errors.player ?? dataset.errors.player,
          match: partial.errors.match ?? dataset.errors.match,
        };
      }
      if (partial.editingMatch !== undefined)
        dataset.editingMatch = partial.editingMatch;
      if (partial.session !== undefined) dataset.session = partial.session;
      if (partial.selectedPlayers !== undefined)
        dataset.selectedPlayers = partial.selectedPlayers;

      State.render(Model.snapshot());
    },

    /** Clear errors only */
    clearErrors: function () {
      dataset.errors = { player: "", match: "" };
    },

    /** Select / deselect player in match form */
    selectPlayer: function (selectId, playerId) {
      if (playerId === "") {
        dataset.selectedPlayers.delete(selectId);
      } else {
        dataset.selectedPlayers.set(selectId, playerId);
      }
      State.render(Model.snapshot());
    },

    snapshot: function () {
      return {
        players: dataset.players.slice(),
        matches: dataset.matches.slice(),
        selectedPlayers: new Map(dataset.selectedPlayers),
        editingMatch: dataset.editingMatch,
        errors: {
          player: dataset.errors.player,
          match: dataset.errors.match,
        },
        session: dataset.session,
      };
    },
  };
})();

/* ═══════════════════════════════════════════════════════
   ACTIONS — async, write to Supabase
   Validation happens server-side (Postgres CHECK + RLS).
   Client-side checks are for UX only (fast feedback).
   On success, Realtime triggers Model.hydrate().
   ═══════════════════════════════════════════════════════ */
const Actions = {
  /* ── Auth ─────────────────────────────────────────── */
  login: async function (email, password) {
    const { data, error } = await sb.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      Model.patch({ errors: { player: error.message } });
      return;
    }
    Model.patch({ session: data.session });
  },

  logout: async function () {
    await sb.auth.signOut();
    Model.patch({ session: null });
  },

  /* ── Players ─────────────────────────────────────── */
  addPlayer: async function (playerData) {
    Model.clearErrors();
    const name = sanitize(playerData.name);
    const surname = sanitize(playerData.surname);
    const role = playerData.role;

    /* Client-side quick checks for instant feedback */
    if (!name) {
      Model.patch({ errors: { player: "Il nome è obbligatorio." } });
      return;
    }
    if (!surname) {
      Model.patch({ errors: { player: "Il cognome è obbligatorio." } });
      return;
    }
    if (role !== "A" && role !== "D") {
      Model.patch({ errors: { player: "Il ruolo è obbligatorio." } });
      return;
    }

    const { error } = await sb.from("players").insert({ name, surname, role });

    if (error) {
      /* Postgres unique constraint → friendly message */
      const msg =
        error.code === "23505" ? "Giocatore già presente." : error.message;
      Model.patch({ errors: { player: msg } });
    }
    /* Realtime will trigger hydrate → re-render */
  },

  removePlayer: async function (playerId) {
    Model.clearErrors();
    const { error } = await sb.from("players").delete().eq("id", playerId);

    if (error) {
      const msg =
        error.code === "P0001"
          ? "Rimozione non permessa — il giocatore ha partite associate."
          : error.message;
      Model.patch({ errors: { player: msg } });
    }
  },

  selectPlayer: function (selectId, playerId) {
    Model.selectPlayer(selectId, playerId);
  },

  /* ── Matches ─────────────────────────────────────── */
  addMatch: async function ({
    home,
    away,
    hScoreD,
    hScoreA,
    aScoreD,
    aScoreA,
    round,
  }) {
    Model.clearErrors();

    /* Client-side quick validation */
    const r = clampInt(round, 1, 999);
    if (r === null) {
      Model.patch({
        errors: { match: "La giornata deve essere tra 1 e 999." },
      });
      return;
    }
    if (!home?.D || !home?.A || !away?.D || !away?.A) {
      Model.patch({ errors: { match: "Seleziona entrambe le squadre." } });
      return;
    }
    const ids = [home.D, home.A, away.D, away.A];
    if (new Set(ids).size !== 4) {
      Model.patch({
        errors: {
          match: "Non è possibile scegliere più volte lo stesso giocatore.",
        },
      });
      return;
    }

    const hdS = clampInt(hScoreD, 0, 99);
    const haS = clampInt(hScoreA, 0, 99);
    const adS = clampInt(aScoreD, 0, 99);
    const aaS = clampInt(aScoreA, 0, 99);
    if (hdS === null || haS === null || adS === null || aaS === null) {
      Model.patch({
        errors: { match: "I punteggi devono essere numeri tra 0 e 99." },
      });
      return;
    }

    const hScore = hdS + haS;
    const aScore = adS + aaS;

    const { error } = await sb.from("matches").insert({
      round: r,
      home_d: home.D,
      home_a: home.A,
      away_d: away.D,
      away_a: away.A,
      home_d_score: hdS,
      home_a_score: haS,
      away_d_score: adS,
      away_a_score: aaS,
      h_score: hScore,
      a_score: aScore,
    });

    if (error) {
      /* Postgres CHECK constraint messages aren't user-friendly,
         so provide a generic fallback */
      Model.patch({
        errors: {
          match:
            error.code === "23514"
              ? "Punteggio non valido — servono vittorie piene (8) o ai vantaggi (scarto di 2)."
              : error.message,
        },
      });
    }
  },

  removeMatch: async function (matchId) {
    Model.clearErrors();
    const { error } = await sb.from("matches").delete().eq("id", matchId);

    if (error) {
      Model.patch({ errors: { match: error.message } });
    }
  },

  startEditMatch: function (matchId) {
    Model.patch({ editingMatch: matchId });
  },

  cancelEditMatch: function () {
    Model.patch({ editingMatch: null });
  },

  updateMatch: async function ({ id, hScore, aScore, round }) {
    Model.clearErrors();
    const r = clampInt(round, 1, 999);
    const hs = clampInt(hScore, 0, 99);
    const as = clampInt(aScore, 0, 99);

    if (r === null || hs === null || as === null) {
      Model.patch({
        errors: { match: "Valori non validi." },
      });
      return;
    }

    const { error } = await sb
      .from("matches")
      .update({ round: r, h_score: hs, a_score: as })
      .eq("id", id);

    if (error) {
      Model.patch({
        errors: {
          match:
            error.code === "23514" ? "Punteggio non valido." : error.message,
        },
      });
      return;
    }

    Model.patch({ editingMatch: null });
  },
};

/* ═══════════════════════════════════════════════════════
   STATE — derives view representation, renders to DOM
   (rendering logic unchanged from original)
   ═══════════════════════════════════════════════════════ */
const State = (function () {
  /* ── Derive standings (pure) ───────────────────────── */
  function deriveStandings(players, matches) {
    const standing = new Map();
    for (const player of players) {
      standing.set(player.id, {
        player,
        played: 0,
        wins: 0,
        losses: 0,
        scored: 0,
        conceded: 0,
        pts: 0,
      });
    }
    for (const m of matches) {
      const hD = standing.get(m.home?.D?.id),
        hA = standing.get(m.home?.A?.id);
      const aD = standing.get(m.away?.D?.id),
        aA = standing.get(m.away?.A?.id);
      if (hD == null || hA == null || aD == null || aA == null) continue;

      hD.played += 1;
      hA.played += 1;
      aD.played += 1;
      aA.played += 1;

      hD.scored += m.home?.D?.score || 0;
      hA.scored += m.home?.A?.score || 0;
      aD.scored += m.away?.D?.score || 0;
      aA.scored += m.away?.A?.score || 0;

      hD.conceded += m.aScore;
      hA.conceded += m.aScore;
      aD.conceded += m.hScore;
      aA.conceded += m.hScore;

      if (m.aScore < m.hScore && m.hScore > 7) {
        hD.wins += 1;
        hA.wins += 1;
        aD.losses += 1;
        aA.losses += 1;
        if (m.hScore === 8 && m.aScore + 1 < m.hScore) {
          hD.pts += 2;
          hA.pts += 2;
        }
        hD.pts += 1;
        hA.pts += 1;
      } else if (m.hScore < m.aScore && m.aScore > 7) {
        aD.wins += 1;
        aA.wins += 1;
        hD.losses += 1;
        hA.losses += 1;
        if (m.aScore === 8 && m.hScore + 1 < m.aScore) {
          aD.pts += 2;
          aA.pts += 2;
        }
        aD.pts += 1;
        aA.pts += 1;
      }
    }
    return [...standing.values()].sort(function (a, b) {
      if (b.pts !== a.pts) return b.pts - a.pts;
      const gda = a.scored - a.conceded;
      const gdb = b.scored - b.conceded;
      if (gdb !== gda) return gdb - gda;
      return b.scored - a.scored;
    });
  }

  function deriveForm(pId, matches) {
    const form = [];
    for (let i = matches.length - 1; i >= 0 && form.length < 3; i--) {
      const m = matches[i];
      const inHome = pId === m.home.D.id || pId === m.home.A.id;
      const inAway = pId === m.away.D.id || pId === m.away.A.id;
      if (!inHome && !inAway) continue;
      const homeWon = m.hScore > m.aScore;
      form.push((inHome && homeWon) || (inAway && !homeWon) ? "W" : "L");
    }
    return form;
  }

  /* ── Safe DOM clear ────────────────────────────────── */
  function clear(id) {
    const node = document.getElementById(id);
    if (node) node.replaceChildren();
    return node;
  }

  /* ── Render: Summary ───────────────────────────────── */
  function renderSummary(standings, matches) {
    const c = clear("summary-stats");
    if (!c) return;
    let totalGoals = 0;
    for (const m of matches) {
      totalGoals += m.hScore + m.aScore;
    }
    const mLen = matches.length;
    const avg = mLen > 0 ? (totalGoals / mLen).toFixed(1) : "0";
    const leader = standings[0];
    const items = [
      { v: String(standings.length), l: "Giocatori" },
      { v: String(mLen), l: "Partite" },
      { v: String(totalGoals), l: "Goal Totali" },
      { v: avg, l: "Media / Partite" },
      {
        v: leader
          ? leader.player.name + " " + leader.player.surname.slice(0, 1) + "."
          : "–",
        l: "In Testa",
      },
      { v: leader ? leader.pts + " pts" : "–", l: "Punteggio Max" },
    ];
    items.forEach(function (item) {
      c.appendChild(
        el("div", { className: "stat-box" }, [
          el("div", { className: "val", textContent: item.v }),
          el("div", { className: "lbl", textContent: item.l }),
        ]),
      );
    });
  }

  /* ── Render: Top Scorers ───────────────────────────── */
  function renderTopScorers(standings) {
    const c = clear("top-scorers-chart");
    if (!c) return;
    if (standings.length === 0) {
      c.appendChild(
        el("p", { className: "empty-msg", textContent: "Nessun dato" }),
      );
      return;
    }
    const byGoals = standings.slice().sort(function (a, b) {
      return b.scored - a.scored;
    });
    const max = byGoals[0].scored || 1;
    byGoals.slice(0, 6).forEach(function (s) {
      const pct = max > 0 ? Math.round((s.scored / max) * 100) : 0;
      const fill = el("div", { className: "bar-fill" }, [String(s.scored)]);
      fill.style.width = Math.max(pct, 10) + "%";
      c.appendChild(
        el("div", { className: "bar-row" }, [
          el("span", {
            className: "name",
            textContent:
              s.player.name + " " + s.player.surname.slice(0, 1) + ".",
          }),
          el("div", { className: "bar-track" }, [fill]),
        ]),
      );
    });
  }

  /* ── Render: Match Card ────────────────────────────── */
  function fmtTeam(side) {
    return (
      side.D.name +
      " " +
      side.D.surname.slice(0, 1) +
      "., " +
      side.A.name +
      " " +
      side.A.surname.slice(0, 1) +
      "."
    );
  }

  function matchCard(m) {
    const hw = m.hScore > m.aScore;
    const aw = m.aScore > m.hScore;
    return el("div", { className: "match" }, [
      el("span", {
        className: "team" + (hw ? " winner" : ""),
        textContent: fmtTeam(m.home),
      }),
      el("span", {
        className: "score",
        textContent: m.hScore + " - " + m.aScore,
      }),
      el("span", {
        className: "team" + (aw ? " winner" : ""),
        textContent: fmtTeam(m.away),
      }),
    ]);
  }

  /* ── Render: Recent Results ────────────────────────── */
  function renderRecentResults(matches) {
    const c = clear("recent-results");
    if (!c) return;
    if (matches.length === 0) {
      c.appendChild(
        el("p", {
          className: "empty-msg",
          textContent: "Nessuna partita.",
        }),
      );
      return;
    }
    matches.slice(-4).forEach(function (m) {
      c.appendChild(matchCard(m));
    });
  }

  /* ── Render: Standings Table ───────────────────────── */
  function renderStandings(standings) {
    const tb = clear("standings-body");
    if (!tb) return;
    standings.forEach(function (s, i) {
      const gd = s.scored - s.conceded;
      const rc = i < 3 ? "rank-" + (i + 1) : "";
      tb.appendChild(
        el("tr", null, [
          el("td", { className: rc, textContent: String(i + 1) }),
          el("td", {
            className: rc,
            textContent:
              s.player.name + " " + s.player.surname.slice(0, 1) + ".",
          }),
          el("td", { textContent: String(s.played) }),
          el("td", { textContent: String(s.wins) }),
          el("td", { textContent: String(s.losses) }),
          el("td", { textContent: String(s.scored) }),
          el("td", { textContent: String(s.conceded) }),
          el("td", {
            textContent: (gd >= 0 ? "+" : "") + gd,
          }),
          el("td", { textContent: String(s.pts) }),
        ]),
      );
    });
  }

  /* ── Render: All Matches (with edit/delete for admin) ─ */
  function renderAllMatches(snap) {
    const c = clear("all-matches");
    if (!c) return;
    const matches = snap.matches;
    const isAdmin = !!snap.session;

    if (matches.length === 0) {
      c.appendChild(
        el("p", {
          className: "empty-msg",
          textContent: "Nessuna partita.",
        }),
      );
      return;
    }

    let curRound = 0;
    matches.forEach(function (m) {
      if (m.round !== curRound) {
        curRound = m.round;
        c.appendChild(
          el("div", {
            className: "round-label",
            textContent: "Giornata " + curRound,
          }),
        );
      }
      if (snap.editingMatch === m.id && isAdmin) {
        c.appendChild(editMatchRow(m));
      } else if (isAdmin) {
        c.appendChild(matchCardWithActions(m));
      } else {
        c.appendChild(matchCard(m));
      }
    });
  }

  function matchCardWithActions(m) {
    const row = matchCard(m);
    const btnEdit = el("button", {
      className: "btn-edit",
      textContent: "Modifica",
    });
    btnEdit.addEventListener("click", function () {
      Actions.startEditMatch(m.id);
    });
    const btnDel = el("button", {
      className: "btn-danger",
      textContent: "Rimuovi",
    });
    btnDel.addEventListener("click", function () {
      Actions.removeMatch(m.id);
    });
    const acts = el("div", { className: "actions-cell" }, [btnEdit, btnDel]);
    acts.style.cssText =
      "display:flex;gap:.3rem;justify-content:center;margin-top:-.2rem;margin-bottom:.3rem;";
    return el("div", null, [row, acts]);
  }

  function editMatchRow(m) {
    const inHs = el("input", {
      type: "number",
      min: "0",
      max: "99",
      value: String(m.hScore),
    });
    inHs.style.width = "50px";
    const inAs = el("input", {
      type: "number",
      min: "0",
      max: "99",
      value: String(m.aScore),
    });
    inAs.style.width = "50px";
    const inRd = el("input", {
      type: "number",
      min: "1",
      max: "999",
      value: String(m.round),
    });
    inRd.style.width = "55px";
    [inHs, inAs, inRd].forEach(function (inp) {
      inp.style.cssText +=
        "background:var(--surface-2);border:1px solid var(--accent);" +
        "border-radius:4px;color:var(--text);padding:.3rem .4rem;" +
        "font-size:.85rem;font-family:inherit;outline:none;";
    });

    const btnSave = el("button", {
      className: "btn btn-primary",
      textContent: "Salva",
    });
    btnSave.addEventListener("click", function () {
      Actions.updateMatch({
        id: m.id,
        hScore: inHs.value,
        aScore: inAs.value,
        round: inRd.value,
      });
    });
    const btnCancel = el("button", {
      className: "btn btn-cancel",
      textContent: "Cancella",
    });
    btnCancel.addEventListener("click", function () {
      Actions.cancelEditMatch();
    });

    const row = el("div", { className: "match" }, [
      el("span", { className: "team", textContent: fmtTeam(m.home) }),
      el("span", null, [inHs, document.createTextNode(" - "), inAs]),
      el("span", { className: "team", textContent: fmtTeam(m.away) }),
    ]);
    row.style.borderColor = "var(--accent)";
    const controls = el("div", { className: "form-row" }, [
      el("div", { className: "field" }, [
        el("label", { textContent: "Giornata" }),
        inRd,
      ]),
      el("div", null, [btnSave, document.createTextNode(" "), btnCancel]),
    ]);
    return el("div", null, [row, controls]);
  }

  /* ── Render: Player Selects ────────────────────────── */
  function renderPlayerSelects(players, selectedPlayers) {
    ["match-home-d", "match-home-a", "match-away-d", "match-away-a"].forEach(
      function (m) {
        const sel = document.getElementById(m);
        if (!sel) return;
        const val = sel.value;
        const role = m.split("-").at(-1).toUpperCase();
        sel.replaceChildren();
        sel.appendChild(el("option", { value: "", textContent: "Seleziona…" }));
        players.forEach(function (p) {
          if (role !== p.role) return;
          let selId = null;
          for (const [k, v] of selectedPlayers) {
            if (v === p.id) {
              selId = k;
              break;
            }
          }
          if (selId !== null && selId !== m) return;
          const opt = el("option", {
            value: p.id,
            textContent: p.name + " " + p.surname,
          });
          if (p.id === val) opt.selected = true;
          sel.appendChild(opt);
        });
      },
    );
  }

  /* ── Render: Player Stats ──────────────────────────── */
  function renderPlayerStats(standings, matches, isAdmin) {
    const tb = clear("player-stats-body");
    if (!tb) return;
    standings.forEach(function (s) {
      const winPct =
        s.played > 0 ? Math.round((s.wins / s.played) * 100) + "%" : "–";
      const form = deriveForm(s.player.id, matches);
      const formCell = el("td");
      form.forEach(function (f, i) {
        const cls = f === "W" ? "badge badge-w" : "badge badge-l";
        formCell.appendChild(el("span", { className: cls, textContent: f }));
        if (i < form.length - 1)
          formCell.appendChild(document.createTextNode(" "));
      });

      const cells = [
        el("td", {
          textContent: s.player.name + ", " + s.player.surname.slice(0, 1),
        }),
        el("td", { textContent: s.player.role }),
        el("td", { textContent: String(s.played) }),
        el("td", { textContent: String(s.scored) }),
        el("td", { textContent: winPct }),
        formCell,
      ];

      if (isAdmin) {
        const btnDel = el("button", {
          className: "btn-danger",
          textContent: "Rimuovi",
        });
        btnDel.addEventListener("click", function () {
          Actions.removePlayer(s.player.id);
        });
        const acts = el("div", { className: "actions-cell" }, [btnDel]);
        acts.style.cssText = "display:flex;gap:.3rem;justify-content:center;";
        cells.push(el("td", null, [acts]));
      }

      tb.appendChild(el("tr", null, cells));
    });
  }

  /* ── Render: Errors ────────────────────────────────── */
  function renderErrors(errors) {
    const pe = document.getElementById("player-error");
    const me = document.getElementById("match-error");
    if (pe) pe.textContent = errors.player;
    if (me) me.textContent = errors.match;
  }

  /* ── Render: Auth UI ───────────────────────────────── */
  function renderAuth(session) {
    const loginBox = document.getElementById("login-box");
    const logoutBox = document.getElementById("logout-box");
    const adminSections = document.querySelectorAll("[data-admin]");

    if (!loginBox || !logoutBox) return;

    if (session) {
      loginBox.style.display = "none";
      logoutBox.style.display = "block";
      const emailEl = document.getElementById("logged-in-email");
      if (emailEl) emailEl.textContent = session.user?.email || "Admin";
      adminSections.forEach(function (el) {
        el.style.display = "";
      });
    } else {
      loginBox.style.display = "block";
      logoutBox.style.display = "none";
      adminSections.forEach(function (el) {
        el.style.display = "none";
      });
    }
  }

  /* ── Main render ───────────────────────────────────── */
  return {
    render: function (snap) {
      const standings = deriveStandings(snap.players, snap.matches);
      const isAdmin = !!snap.session;

      renderAuth(snap.session);
      renderSummary(standings, snap.matches);
      renderTopScorers(standings);
      renderRecentResults(snap.matches);
      renderStandings(standings);
      renderAllMatches(snap);
      if (isAdmin) {
        renderPlayerSelects(snap.players, snap.selectedPlayers);
      }
      renderPlayerStats(standings, snap.matches, isAdmin);
      renderErrors(snap.errors);
    },
  };
})();

/* ═══════════════════════════════════════════════════════
   REALTIME — subscribe to Postgres changes
   ═══════════════════════════════════════════════════════ */
function initRealtime() {
  sb.channel("tournament")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "players" },
      function () {
        Model.hydrate();
      },
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "matches" },
      function () {
        Model.hydrate();
      },
    )
    .subscribe(function (status) {
      console.log("Realtime status:", status);
    });
}

/* ═══════════════════════════════════════════════════════
   VIEW WIRING — DOM events → Actions
   ═══════════════════════════════════════════════════════ */
(async function initView() {
  /* ── Check for existing session (page refresh) ────── */
  const {
    data: { session },
  } = await sb.auth.getSession();
  Model.patch({ session: session });

  /* ── Listen for auth state changes ──────────────── */
  sb.auth.onAuthStateChange(function (_event, session) {
    Model.patch({ session: session });
  });

  /* ── Login form ──────────────────────────────────── */
  const btnLogin = document.getElementById("btn-login");
  if (btnLogin) {
    btnLogin.addEventListener("click", function () {
      const email = document.getElementById("login-email").value;
      const pwd = document.getElementById("login-password").value;
      Actions.login(email, pwd);
    });
  }

  /* ── Logout ──────────────────────────────────────── */
  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout) {
    btnLogout.addEventListener("click", function () {
      Actions.logout();
    });
  }

  /* ── Add Player ──────────────────────────────────── */
  const btnAddPlayer = document.getElementById("btn-add-player");
  if (btnAddPlayer) {
    btnAddPlayer.addEventListener("click", function () {
      const playerData = {
        name: document.getElementById("player-name").value,
        surname: document.getElementById("player-surname").value,
        role: document.getElementById("player-role").value,
      };
      Actions.addPlayer(playerData);
      document.getElementById("player-name").value = "";
      document.getElementById("player-surname").value = "";
      document.getElementById("player-role").selectedIndex = 0;
    });
  }

  /* ── Add Match ───────────────────────────────────── */
  const btnAddMatch = document.getElementById("btn-add-match");
  if (btnAddMatch) {
    btnAddMatch.addEventListener("click", function () {
      Actions.addMatch({
        home: {
          D: document.getElementById("match-home-d").value,
          A: document.getElementById("match-home-a").value,
        },
        away: {
          D: document.getElementById("match-away-d").value,
          A: document.getElementById("match-away-a").value,
        },
        hScoreD: parseInt(document.getElementById("match-home-score-d").value),
        hScoreA: parseInt(document.getElementById("match-home-score-a").value),
        aScoreD: parseInt(document.getElementById("match-away-score-d").value),
        aScoreA: parseInt(document.getElementById("match-away-score-a").value),
        round: document.getElementById("match-round").value,
      });
    });
  }

  /* ── Player Selects (listeners attached once) ────── */
  ["match-home-d", "match-home-a", "match-away-d", "match-away-a"].forEach(
    function (m) {
      const sel = document.getElementById(m);
      if (sel) {
        sel.addEventListener("change", function (event) {
          Actions.selectPlayer(m, event.target.value);
        });
      }
    },
  );

  /* ── Tabs ────────────────────────────────────────── */
  const btns = document.querySelectorAll("[role=tab]");
  const panels = document.querySelectorAll("[role=tabpanel]");
  function activate(btn) {
    btns.forEach(function (b) {
      b.setAttribute("aria-selected", "false");
      b.setAttribute("tabindex", "-1");
    });
    panels.forEach(function (p) {
      p.classList.remove("active");
    });
    btn.setAttribute("aria-selected", "true");
    btn.removeAttribute("tabindex");
    const t = document.getElementById(btn.getAttribute("aria-controls"));
    if (t) t.classList.add("active");
  }
  btns.forEach(function (b) {
    b.addEventListener("click", function (e) {
      activate(e.currentTarget);
    });
    b.addEventListener("keydown", function (e) {
      const idx = Array.prototype.indexOf.call(btns, e.currentTarget);
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown")
        next = (idx + 1) % btns.length;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp")
        next = (idx - 1 + btns.length) % btns.length;
      if (next >= 0) {
        e.preventDefault();
        btns[next].focus();
        activate(btns[next]);
      }
    });
  });

  /* ── Boot: hydrate from Supabase + start Realtime ── */
  await Model.hydrate();
  initRealtime();
})();
