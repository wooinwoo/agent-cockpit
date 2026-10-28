!macro NSIS_HOOK_PREINSTALL
  ; Tauri performs its application-specific running-process check after this hook.
  ; Installation must preserve user data and must not stop unrelated port listeners.
!macroend
