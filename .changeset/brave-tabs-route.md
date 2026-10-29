---
"@vivari/core": patch
---

Preview: each preview request is routed to the kernel that owns it, so two Studio tabs
on one origin — each with its own kernel and dev server, both binding the same in-VM
port — no longer serve each other's previews. A navigation is attributed to the window
that started it and the frame it creates is remembered by resultingClientId; keep-prefix
ports are tracked per kernel, and ws/SSE tunnel frames stay with their own kernel's
preview windows.
