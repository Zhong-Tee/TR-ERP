# Project UI conventions

- Use the shared application Modal component for user confirmations and text input dialogs.
- Do not use browser-native `alert`, `confirm`, or `prompt` dialogs (including `window.alert`, `window.confirm`, and `window.prompt`). Show validation and errors within the application UI.
- Preserve this convention when adding or modifying user flows. This preference was explicitly requested by the user.
