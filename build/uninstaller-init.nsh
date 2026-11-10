; The one-click per-machine uninstaller sets its CWD to $INSTDIR before
; initMultiUser. Its non-admin outer process then waits inside UAC_RunElevated
; while the elevated inner process runs the uninstall section. Both instances
; must leave $INSTDIR before that wait; customUnInit runs too late.
!ifndef BUILD_UNINSTALLER
  !error "Uninstaller initialization is only valid in the uninstaller build"
!endif
!ifndef ONE_CLICK
  !error "Uninstaller initialization requires one-click mode"
!endif
!ifndef INSTALL_MODE_PER_ALL_USERS
  !error "Uninstaller initialization requires per-machine mode"
!endif

; Preserve the one-click mode selection, adding only the pre-elevation CWD move.
!macroundef initMultiUser
!macro initMultiUser
  SetOutPath "$TEMP"
  !insertmacro setInstallModePerAllUsers
!macroend
