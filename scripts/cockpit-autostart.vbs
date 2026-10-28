' Cockpit Dashboard — Windows login auto-start (WSL user service)
'
' Ubuntu의 rst010 사용자가 설치한 cockpit-prod.service를 시작합니다.
' 저장소 경로와 서버 실행 방식은 서비스 파일에서 관리합니다.
' 먼저 해당 WSL 사용자의 systemd user manager에 서비스를 설치하세요.
'
' 사용법:
'   이 파일을 Windows Startup 폴더에 복사:
'      %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
'
' 이미 실행 중인 서비스에는 중복 서버를 만들지 않습니다.
' 로그는 WSL 내부 /tmp/cockpit.log에 기록합니다.

Option Explicit

Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "wsl.exe -d Ubuntu -u rst010 -- /usr/bin/systemctl --user start cockpit-prod.service", 0, False
