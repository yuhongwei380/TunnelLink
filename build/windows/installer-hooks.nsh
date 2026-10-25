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
