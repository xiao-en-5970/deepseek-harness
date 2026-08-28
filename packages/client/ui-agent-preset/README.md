# dsh-client-ui-agent-preset

English | [中文](README.zh.md)

The agent-preset surfaces live in settings: a General row chooses which [preset](../../preset/agent-presets/README.md) new DSH sessions are composed from, and a management section handles the roster — copy, delete, default, and the way into a preset's own files.

The reserved `zcode` preset is absent from both surfaces. The homepage DSH/ZCode button exclusively changes the agent engine; no agent-preset chip or label is registered there. The composer model selector remains a separate per-session control.

## Why it is a new-session preference

A session's preset is fixed when the session is created — the host refuses to adopt an existing session under a different one, because that session's history was produced under the first preset's tools. So this row cannot be a live switch, and it says so: changing it applies to sessions started afterwards while running sessions keep the composition they began with.

## What it reads and writes

Options and the current default both come from one `agentPreset.list` call after removing the reserved `zcode` row. The roster already reports which id a session with no explicit choice gets, so the row needs no settings-schema introspection; the write targets the `agent-presets` settings namespace's `default` field, which is what the host resolves at creation.

A locally authored preset is exactly as privileged as the plugins it names, so the list marks `user` rows rather than presenting every preset as shipped and vetted.

Preset files publish one unlocalized `name` and `description`, which Web uses for every `user` row and unknown `system` row. For the four shipped ids (`standard`, `code`, `minimal`, and `cordis`), Web resolves both fields from its active locale only when the roster marks the row `system`; an identically named `user` preset keeps its file metadata.

The row re-reads on `settings/changed` for its own namespace and on `connection/reset`: the roster is a live directory and the default is a settings field, so an external edit or a reconnect can both move it.

## The management section

Its own settings page (`settings.section` id `agent-presets`, ordered after Models) shows the roster as cards, a copy dialog as the only way a preset is created, and a read-only viewer over the shipped compositions.

The browser edits no composition text. Editing YAML in a web textarea was a weak surface (no completion, no highlighting, no diff), so a new preset is a host-side copy of an existing one — the dialog collects an id (it becomes the directory name, which is why it must be named up front and cannot change later) and an optional display name, and `{ from, id, name? }` is all that crosses the wire. Everything else — description, composition, skills — is edited in the preset's own files, and the page's other job is getting the user TO those files: the copy completes by opening the new directory, and every custom row keeps a location action. Where the host has no desktop opener (`hasDocument: false` on the roster; remote and container deployments), the same actions answer the directory as text on the row instead of offering a button that would spawn into nothing.

A preset publishes its own description, of any length, and the grid sizes every card row alike — so an unbounded description would set the height of the whole roster. Cards clamp it to four lines and offer the rest in a tooltip, attached only while the text is actually cut off. The clamp is CSS, so the whole description stays in the accessibility tree whatever the card shows.

A shipped preset opens in the read-only viewer. It is the known-good composition a copy starts from, so reading it is the point; it offers no location and no delete — its install is overwritten by upgrades and is not the user's to manage. The intro carries the guidance a create button used to imply: duplicate an existing preset and make it yours, or let the agent draft one in Creator mode.

Beside copying sits the conversational entry: when the roster carries the self-referential `cordis` preset, a dashed add-card stages it and starts a new session. An internal controller applies that composition when the workspace flow produces its blank session; no homepage preset control is exposed.

The dialog mirrors the host's own containment rule (`[a-z0-9][a-z0-9-]*`) and refuses a name already in use — a copy never overwrites. Both checks are conveniences: the host re-applies them and its answer is what the dialog reports on failure.

Deleting removes the preset directory. Sessions already composed from it keep running — a composition is mounted once at session creation and nothing re-reads the file.

A roster row carrying `broken` (the host's shape check found the composition missing or unloadable) renders as a marked card: red border, a "Failed to load" badge, the reason verbatim, the body disabled, and duplication disabled. A broken custom row keeps its location and delete actions; a broken shipped row withholds the viewer too. The General picker drops broken presets entirely because offering one would defer failure to session start.

Setting the default writes the `agent-presets` settings namespace, which the host exposes to configuration clients ([`dsh-apiproxy`](../../host/apiproxy/README.md) keeps an explicit allowlist — a namespace outside it makes a picker move and then silently forget).

`agentPreset.read`, `copy`, `openDocument`, and `remove` are loopback-pinned ([`dsh-client-connection`](../connection/README.md)): a composition names the plugins a session runs, so reading one is reconnaissance, and the rest manage the roster and drive the host desktop. `agentPreset.list` is not — it carries ids, trust, and the two path-free capability flags, and a LAN client's picker needs it.

## When the surfaces are absent

A deployment that composes no presets answers with an empty roster, and the row and section render nothing. A deployment that configures no writable root answers `authorable: false`, and the section stays a read-only browser.

## Model Experience

Indirectly, through the preset a later session is composed from; [`dsh-agent-presets`](../../preset/agent-presets/README.md) owns what that composition puts in front of the model.

#### KV Cache effect

No direct invalidation. Changing the default never touches a running session's prefix; a session created afterwards establishes its own prefix from its own composition.

## Known Limitations and Deferred Work

- **A preset without metadata is listed by id** — display text is optional, and a copy given no name deliberately falls back to its directory name rather than presenting itself identically to its source.
- **A revealed path is display text, not a link** — where the host has no desktop opener the row shows the directory to copy by hand; the browser cannot open a host filesystem location itself.
- **Composition edits are invisible to the page** — the files are edited outside the browser and nothing on the wire announces a file change, so the roster re-reads on its own actions, `settings/changed`, and `connection/reset`, not on every disk edit.
