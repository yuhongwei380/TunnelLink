!include "x64.nsh"

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Preparing the VPN network adapter..."
  ${DisableX64FSRedirection}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\windows\install-tap-driver.ps1" -DriverDirectory "$INSTDIR\drivers\windows-x64\tap-windows6" -LogPath "$INSTDIR\driver-install.log"'
  Pop $0
  Pop $1
  ${EnableX64FSRedirection}
  DetailPrint "$1"
  ${If} $0 == "3010"
    SetRebootFlag true
    SetErrorLevel 3010
  ${ElseIf} $0 != "0"
    MessageBox MB_OK|MB_ICONSTOP "VPN driver setup failed. See $INSTDIR\driver-install.log, then run this installer again." /SD IDOK
    SetErrorLevel 1
    Abort "VPN driver setup failed."
  ${EndIf}
!macroend

; Shared TAP drivers/adapters are deliberately retained on uninstall.

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop the GUI before clearing account data so an in-flight login or WebView
  ; shutdown cannot recreate it. Keep all user data during updater replacement.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${If} $UpdateMode <> 1
    DetailPrint "Removing Tunnel Link credentials, settings, and caches..."
    nsExec::ExecToStack '"$INSTDIR\${MAINBINARYNAME}.exe" --clear-uninstall-data'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      MessageBox MB_OK|MB_ICONSTOP "Credentials or application data could not be removed. Uninstallation has stopped; please retry using the Windows account that used the client." /SD IDOK
      SetErrorLevel 1
      Abort "Unable to remove application data."
    ${EndIf}
  ${EndIf}
!macroend
