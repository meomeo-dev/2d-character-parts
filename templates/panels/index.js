// Feature-panel loader.
//
// Dynamically imports each optional panel module and calls its exported
// mount(). Modules that do not exist yet are skipped silently, so feature
// tracks can add templates/panels/<name>.js without touching studio.html.
//
//   Track C: templates/panels/chat-panel.js   -> export mount() -> #chat-panel
//   Track B: templates/panels/animation-panel.js -> export mount() -> #animation-panel
const panels = ['./chat-panel.js', './animation-panel.js'];
for (const p of panels) {
  import(p).then(m => m.mount && m.mount()).catch(() => {}); // missing file: skip
}
