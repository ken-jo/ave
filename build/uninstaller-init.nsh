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

Var aveSilentUninstallRequested

; The template also enables silent mode for GUI uninstalls. Preserve the
; invoking command line's intent independently of that mutable runtime state.
!macro customUnInit
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $aveSilentUninstallRequested "0"
  ${StdUtils.ParameterCnt} $R0
  StrCmp $R0 "error" ave_uninstall_arguments_failed
  StrCpy $R1 "0"
  ave_uninstall_arguments_next:
    IntCmp $R1 $R0 ave_uninstall_arguments_done 0 ave_uninstall_arguments_done
    ${StdUtils.ParameterStr} $R2 $R1
    ; _?= consumes the remaining unquoted installation path.
    StrCpy $R3 $R2 3
    StrCmpS $R3 "_?=" ave_uninstall_arguments_done
    StrCmpS $R2 "/S" ave_uninstall_arguments_silent
    IntOp $R1 $R1 + 1
    Goto ave_uninstall_arguments_next
  ave_uninstall_arguments_silent:
    StrCpy $aveSilentUninstallRequested "1"
  ave_uninstall_arguments_done:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Goto ave_uninstall_arguments_ready
  ave_uninstall_arguments_failed:
    SetErrorLevel 1
    Abort "Ave uninstall failed: command-line arguments could not be read"
  ave_uninstall_arguments_ready:
!macroend

; Preserve the one-click mode selection, adding only the pre-elevation CWD move.
!macroundef initMultiUser
!macro initMultiUser
  SetOutPath "$TEMP"
  !insertmacro setInstallModePerAllUsers
!macroend
