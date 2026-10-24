// Styles for the Bot panel only.
//
// Why this file exists (T4 root cause): the first version of the panel reused
// `.bt-panel` from src/client/styles.js as its root, but that class is the right-hand
// *drawer* (`position:fixed;right:0;width:320px`). Mounted inside the centre column it
// therefore painted as a 320px strip pinned to the window edge, and the panel's own
// layout classes (`bt-panel-side`, `bt-chat`, `bt-composer`, …) were never defined at
// all — so the real panel rendered as a column of unstyled text. That is what the user
// reported as "进去是假的". The panel now owns its class names (`bt-wg-*`) and this
// sheet defines every one of them.
//
// Rules kept from the plan: reuse the original `bt-*` tokens and the classes that do
// exist (`bt-row`, `bt-list`, `bt-input`, `bt-soft`, `bt-hint`), introduce no new
// palette, and give every `var()` a literal fallback so the panel still reads correctly
// when the Bot-mode shell (which publishes `--bt-*` on `body`) is not installed.
export const WG_CSS = `
.bt-wg{display:flex;flex:1 1 auto;flex-direction:row;min-width:0;min-height:0;height:100%;background:var(--bt-main,#fcfcfc);color:var(--bt-ink,#141414);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;box-sizing:border-box}
.bt-wg *,.bt-wg *:before,.bt-wg *:after{box-sizing:border-box}

/* Left column: the workgroup list. */
.bt-wg-side{flex:none;width:272px;min-width:0;display:flex;flex-direction:column;min-height:0;border-right:.5px solid var(--bt-line-2,rgba(20,20,20,.15));background:var(--bt-sidebar,#f7f7f7)}
.bt-wg-head{display:flex;align-items:center;gap:8px;padding:16px 16px 10px;min-height:40px}
.bt-wg-title{font-size:15px;line-height:20px;font-weight:600;white-space:nowrap}
.bt-wg-count{margin-left:auto;font-size:12px;color:var(--bt-ink-3,rgba(20,20,20,.36));font-variant-numeric:tabular-nums}
.bt-wg-list{display:flex;flex-direction:column;gap:3px;overflow-y:auto;min-height:0;flex:1 1 auto;padding:0 8px 8px}
.bt-wg-create{padding:8px;border-top:.5px solid var(--bt-line,rgba(20,20,20,.08));display:flex;flex-direction:column;gap:8px}
.bt-wg-members{display:flex;flex-wrap:wrap;gap:6px;max-height:132px;overflow-y:auto}

/* One row. bt-row supplies the hit area; these add the two-part body. */
.bt-wg-row-wrap{position:relative;display:flex;align-items:center;gap:6px}.bt-wg-row-wrap>.bt-row{flex:1 1 auto;min-width:0}
.bt-wg-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;text-align:left}
.bt-wg-name{font-size:14px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-wg-preview{font-size:12px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-wg-avatar{flex:none;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink-2,rgba(20,20,20,.6));font-size:12px;font-weight:600}
.bt-wg-row-menu{display:flex;gap:4px;flex:none;opacity:0;pointer-events:none;transition:opacity .12s ease}
.bt-wg-row-wrap:hover .bt-wg-row-menu,.bt-wg-row-wrap:focus-within .bt-wg-row-menu{opacity:1;pointer-events:auto}

/* The workgroup marker (T1). A text chip, not a colour: it stays legible for
   colour-blind users and in both themes, and it is the same string the row's
   aria-label carries. */
.bt-wg-mark{flex:none;display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;border-radius:5px;border:.5px solid var(--bt-line-2,rgba(20,20,20,.15));background:var(--bt-tag-bg,rgba(20,20,20,.06));color:var(--bt-tag-ink,rgba(20,20,20,.56));font-size:11px;line-height:1;font-weight:500;white-space:nowrap}
.bt-wg-mark-glyph{font-size:10px;line-height:1;opacity:.75}
.bt-wg-link{font-size:11px;line-height:15px;color:var(--bt-ink-3,rgba(20,20,20,.36));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Right column: the open workgroup. */
.bt-wg-main{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column}
.bt-wg-chat{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.bt-wg-chat-head{flex:none;display:flex;align-items:center;gap:8px;padding:12px 20px;border-bottom:.5px solid var(--bt-line,rgba(20,20,20,.08));min-height:52px}
.bt-wg-chat-head>.bt-cluster,.bt-wg-chat-head>.bt-mark,.bt-wg-chat-head>.bt-stack{flex:none;margin-right:2px}
.bt-wg-chat-name{font-size:15px;line-height:20px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-wg-chat-sub{font-size:12px;color:var(--bt-ink-3,rgba(20,20,20,.36));white-space:nowrap}
.bt-wg-log{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 20px;display:flex;flex-direction:column;gap:10px}
/* The work indicator: the original activity row's look (a mark, a shimmering phrase, an elapsed
   clock), stacked so several members at work fit above the composer. Spring in, fade out, and the
   shimmer comes from the original .bt-shimmer, so this file adds no second animation language. */
.bt-wg-working{flex:none;display:flex;flex-direction:column;gap:6px;padding:2px 20px 8px;min-width:0}
.bt-wg-working-line{display:flex;align-items:center;gap:8px;min-width:0;transform-origin:0 50%;animation:bt-wg-working-in 220ms cubic-bezier(.23,1,.32,1) backwards}
.bt-wg-working-line>.bt-shimmer{flex:1 1 auto;min-width:0;font-size:13px;line-height:20px;color:var(--bt-ink-2,rgba(20,20,20,.6));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-wg-working-time{flex:none;font-size:11px;line-height:20px;color:var(--bt-ink-3,rgba(20,20,20,.36));font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-wg-working-more{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3,rgba(20,20,20,.36));padding-inline-start:26px}
/* The round's current speaker is the one the reader is waiting on, so it reads one step darker. */
.bt-wg-working-line[data-speaking="true"]>.bt-shimmer{color:var(--bt-ink,#141414);font-weight:500}
@keyframes bt-wg-working-in{from{opacity:0;transform:scale(.94)}}
@media (prefers-reduced-motion:reduce){.bt-wg-working-line{animation:none}}
.bt-wg-line{font-size:14px;line-height:21px;color:var(--bt-ink,#141414);overflow-wrap:anywhere}
.bt-wg-line-who{font-weight:600;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.bt-wg-at{color:var(--bt-accent,#4d6bfe);font-weight:500;border-radius:4px}
.bt-wg-at-all{background:var(--bt-tag-bg,rgba(20,20,20,.06));padding:0 3px}
.bt-wg-line-note{font-size:12px;line-height:18px;color:var(--bt-ink-3,rgba(20,20,20,.36));font-style:italic}
.bt-wg-compose{flex:none;padding:10px 20px 16px;display:flex;flex-direction:column;gap:8px}
.bt-wg-compose-input{width:100%;min-height:64px;max-height:180px;resize:vertical;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:10px;padding:10px 12px;background:var(--bt-card,#ffffff);color:var(--bt-ink,#141414);font:inherit;font-size:14px;line-height:20px;outline:none}
.bt-wg-compose-input:focus-visible{border-color:var(--bt-line-2,rgba(20,20,20,.15))}
.bt-wg-compose-actions{display:flex;gap:8px;justify-content:flex-end}
.bt-wg-conn{flex:none;display:flex;align-items:center;gap:6px;padding:0 20px 10px;font-size:11px;line-height:16px;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.bt-wg-conn-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--bt-ink-3,rgba(20,20,20,.36))}
.bt-wg-conn-ok .bt-wg-conn-dot{background:var(--bt-green,#00c972)}
.bt-wg-conn-down{color:var(--bt-danger,#e02135)}
.bt-wg-conn-down .bt-wg-conn-dot{background:var(--bt-danger,#e02135)}
.bt-wg-conn-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* G4: the Hub roster, the invite control, the attachment note, and the archived banner.
   The roster reuses the original bt-row rhythm so a member list reads like the team's own. */
.bt-wg-roster{flex:none;display:flex;flex-direction:column;gap:6px;padding:0 20px 8px;max-height:168px;overflow-y:auto}
.bt-wg-roster-head{font-size:11px;line-height:16px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.bt-wg-roster-list{display:flex;flex-wrap:wrap;gap:6px}
.bt-wg-roster-row{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;background:var(--bt-hover,rgba(119,119,119,.09));font-size:12px;line-height:18px;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.bt-wg-roster-row[data-member-type="botEndpoint"]{color:var(--bt-ink,#141414)}
.bt-wg-roster-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.bt-wg-roster-role{font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;background:var(--bt-card,#ffffff);color:var(--bt-ink-3,rgba(20,20,20,.36))}
.bt-wg-invite{display:flex;align-items:center;gap:6px;margin-top:2px}
.bt-wg-invite>.bt-input{flex:1 1 auto;min-width:0}
.bt-wg-file{font-size:11px;color:var(--bt-ink-3,rgba(20,20,20,.36));max-width:150px}
.bt-wg-note{padding:6px 10px;border-radius:8px;background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink-2,rgba(20,20,20,.6));font-size:12px;line-height:17px}
.bt-wg-archived{padding:8px 10px;border-radius:8px;margin:0 20px 8px;background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink-2,rgba(20,20,20,.6));font-size:12px;line-height:17px}
.bt-wg-compose-archived{padding:12px 20px 16px;color:var(--bt-ink-2,rgba(20,20,20,.6));font-size:12px;line-height:17px}
.bt-wg-line[data-via="hub"] .bt-wg-line-who::after{content:" · Hub";font-size:10px;color:var(--bt-ink-3,rgba(20,20,20,.36));font-weight:400}
.bt-wg-unread{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-green,#00c972);color:#fff;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-wg-presence{flex:none;width:6px;height:6px;border-radius:50%;background:var(--bt-ink-3,rgba(20,20,20,.36))}
.bt-wg-presence-on{background:var(--bt-green,#00c972)}
.bt-wg-inbox{display:flex;flex-direction:column;gap:6px;padding:0 16px 8px}
.bt-wg-invite-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.bt-wg-invite-name{font-size:13px;line-height:18px;font-weight:500}
.bt-wg-invite-from{font-size:11px;line-height:16px;color:var(--bt-ink-3,rgba(20,20,20,.36));margin-right:auto}
.bt-wg-publish{display:flex;flex-direction:column;gap:4px}
/* The approval cards. Same row vocabulary as the invite inbox, because they are the same kind of
   thing: something from another account that waits for a decision here. */
.bt-wg-tasks{display:flex;flex-direction:column;gap:6px;padding:0 16px 8px}
.bt-wg-task-row{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;background:var(--bt-hover,rgba(119,119,119,.09))}
.bt-wg-task-title{font-size:13px;line-height:18px;font-weight:500}
.bt-wg-task-meta{font-size:11px;line-height:16px;color:var(--bt-ink-3,rgba(20,20,20,.36))}
.bt-wg-task-scope{font-size:11px;line-height:16px;color:var(--bt-ink-2,rgba(20,20,20,.6));word-break:break-word}
.bt-wg-task-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}
.bt-wg-task-mode{flex:1 1 auto;min-width:0}
.bt-wg-line-files{display:inline-flex;flex-wrap:wrap;gap:6px;margin-left:6px}
.bt-wg-attach{display:inline-flex;align-items:center;gap:4px}
.bt-wg-empty{flex:1 1 auto;display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--bt-ink-2,rgba(20,20,20,.6));padding:24px;text-align:center}
.bt-wg-error{margin:8px 8px 0;padding:8px 10px;border-radius:8px;background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-danger,#e02135);font-size:12px;line-height:17px}

/* Structural fallbacks for the original classes this panel borrows.
   src/client/styles.js installs the .bt-* definitions as part of the Bot-mode shell
   group, but the "Bot" nav entry also exists on the plain surface — where that group is
   not installed and these classes would render unstyled. Scoped under .bt-wg, so this
   never changes the original team's own rendering, and higher specificity than the bare
   .bt-* rule, so the panel looks the same in both surfaces. */
.bt-wg .bt-row{position:relative;display:flex;align-items:center;gap:8px;min-height:54px;padding:8px;border:0;border-radius:10px;background:transparent;color:var(--bt-ink,#141414);text-align:left;cursor:pointer;width:100%;font-family:inherit}
.bt-wg .bt-row:hover{background:var(--bt-hover,rgba(119,119,119,.09))}
.bt-wg .bt-row-active{background:var(--bt-active,rgba(119,119,119,.17))}
.bt-wg .bt-row-name{display:flex;align-items:center;gap:6px;min-width:0}
.bt-wg .bt-input{width:100%;height:36px;border:1px solid var(--bt-line,rgba(20,20,20,.08));border-radius:8px;padding:0 10px;background:var(--bt-card,#ffffff);color:var(--bt-ink,#141414);font:inherit;font-size:13px;outline:none}
.bt-wg .bt-soft{height:36px;border-radius:999px;border:0;background:var(--bt-hover,rgba(119,119,119,.09));color:var(--bt-ink,#141414);padding:0 16px;font-size:14px;cursor:pointer;flex:none;white-space:nowrap;font-family:inherit}
.bt-wg .bt-soft-sm{height:28px;padding:0 12px;font-size:12px}
.bt-wg .bt-soft:disabled{opacity:.5;cursor:default}
.bt-wg .bt-danger{color:var(--bt-danger,#e02135)}
.bt-wg .bt-hint{padding:14px;text-align:center;font-size:13px;color:var(--bt-ink-2,rgba(20,20,20,.6))}
.bt-wg .bt-badge{position:absolute;right:0;bottom:0;width:12px;height:12px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--bt-danger,#e02135);color:#fff;font-size:9px;font-weight:600;box-shadow:0 0 0 1.5px var(--bt-sidebar,#f7f7f7)}
@media (prefers-reduced-motion:reduce){.bt-wg-row-menu{transition:none}}
`

