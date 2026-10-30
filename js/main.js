import { boot } from './ui/app.js';

if (location.protocol === 'file:') {
  document.body.innerHTML = '<div style="font:15px/1.5 system-ui;padding:40px;max-width:640px">This prototype uses ES modules, which browsers block on <code>file://</code>. Serve the folder instead — for example <code>python -m http.server 8765</code> in this folder, then open <a href="http://localhost:8765">http://localhost:8765</a> (or use VS Code Live Server).</div>';
} else {
  boot();
}
