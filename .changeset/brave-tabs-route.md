---
"@vivari/core": patch
---

Preview: each preview request is routed to the kernel that owns it, so two Studio tabs
on one origin — each with its own kernel and dev server, both binding the same in-VM
port — no longer serve each other's previews. A navigation is attributed to the window
that started it and the frame it creates is remembered by resultingClientId; keep-prefix
ports are tracked per kernel, and ws/SSE tunnel frames stay with their own kernel's
preview windows.

A frame's first navigation carries no client id in Chrome, so in same-origin mode
`previewUrlFor()` now adds this kernel's token as a `__vv_kernel` query parameter (also
available as `KernelBridge.sameOriginPreviewUrl()`), and `vv-kernel-host` carries the same
token. The SW routes that navigation by the token and redirects to the URL without it, so
the app never sees the parameter. If you compare or parse URLs returned by
`previewUrlFor()`, expect the extra parameter in same-origin mode.
