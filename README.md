# Safe Pin

Prevent pinned tabs in SiYuan from being closed by mistake.

## Behavior

- Blocks closing the active pinned tab with `Ctrl/Cmd + W`
- Blocks tab closing triggered from the tab close button
- Blocks tab closing triggered from the tab context menu
- Allows closing again after the tab is unpinned

## Notes

This plugin patches SiYuan's runtime tab closing methods so all common close paths are handled consistently.
