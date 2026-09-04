; The Windows installer for this fork's tode build. The payload is what
; scripts\build-windows.ps1 stages into out\windows-release\tode — the same
; tree the release zip carries — and scripts\package-windows.ps1 is what
; compiles this, deriving the numeric MyAppVersion from the payload's VERSION.
; The shape follows terminal-browser's installer so the pair install alike:
; per-user under {localappdata}\Programs, a user-PATH task, no elevation.

#define MyAppName "tode"
#ifndef MyAppVersion
#define MyAppVersion "0.0.0.0"
#endif
#ifndef PayloadDir
#define PayloadDir "..\out\windows-release\tode"
#endif
#define MyAppPublisher "Noriaki Fukuyori"
#define MyAppURL "https://github.com/fukuyori/terminal-code"

[Setup]
AppId={{EA2AADC4-5381-4AE5-A2B1-F8F22469A861}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} Windows installer
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
LicenseFile=..\LICENSE
OutputDir=..\out\windows-release
OutputBaseFilename=tode-{#MyAppVersion}-windows-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
ChangesEnvironment=yes
RestartApplications=no
#ifdef SignTool
SignTool={#SignTool}
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[CustomMessages]
english.AddToPath=Add tode to the user PATH
japanese.AddToPath=tode をユーザー PATH に追加する
english.AdditionalTasks=Additional tasks:
japanese.AdditionalTasks=追加タスク:
english.NeedsBrowser=tode needs terminal-browser, which is not installed yet. Install it from%nhttps://github.com/fukuyori/terminal-browser/releases%nbefore running tode.
japanese.NeedsBrowser=tode の実行には terminal-browser が必要ですが、まだインストールされていません。%nhttps://github.com/fukuyori/terminal-browser/releases%nからインストールしてから tode を実行してください。

[Tasks]
Name: "addtopath"; Description: "{cm:AddToPath}"; GroupDescription: "{cm:AdditionalTasks}"; Flags: checkedonce

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Code]
const
  UserEnvironmentKey = 'Environment';

function UserPathContains(Entry: String): Boolean;
var
  ExistingPath: String;
begin
  if not RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', ExistingPath) then
    ExistingPath := '';
  Result := Pos(';' + Lowercase(Entry) + ';',
    ';' + Lowercase(ExistingPath) + ';') > 0;
end;

procedure AddToUserPath(Entry: String);
var
  ExistingPath: String;
begin
  if UserPathContains(Entry) then
    Exit;
  if not RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', ExistingPath) then
    ExistingPath := '';
  if (ExistingPath <> '') and (ExistingPath[Length(ExistingPath)] <> ';') then
    ExistingPath := ExistingPath + ';';
  RegWriteExpandStringValue(HKCU, UserEnvironmentKey, 'Path', ExistingPath + Entry);
end;

procedure RemoveFromUserPath(Entry: String);
var
  ExistingPath: String;
  PaddedPath: String;
  MatchAt: Integer;
begin
  if not RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', ExistingPath) then
    Exit;

  PaddedPath := ';' + ExistingPath + ';';
  MatchAt := Pos(';' + Lowercase(Entry) + ';', Lowercase(PaddedPath));
  while MatchAt > 0 do
  begin
    Delete(PaddedPath, MatchAt, Length(Entry) + 1);
    MatchAt := Pos(';' + Lowercase(Entry) + ';', Lowercase(PaddedPath));
  end;

  while Pos(';;', PaddedPath) > 0 do
    StringChangeEx(PaddedPath, ';;', ';', True);
  if (Length(PaddedPath) > 0) and (PaddedPath[1] = ';') then
    Delete(PaddedPath, 1, 1);
  if (Length(PaddedPath) > 0) and (PaddedPath[Length(PaddedPath)] = ';') then
    Delete(PaddedPath, Length(PaddedPath), 1);

  if PaddedPath <> ExistingPath then
    RegWriteExpandStringValue(HKCU, UserEnvironmentKey, 'Path', PaddedPath);
end;

// tode draws its pane with terminal-browser, installed separately. A missing
// browser is worth a note on the way out, not a reason to refuse the install.
function HasBrowser: Boolean;
begin
  Result := FileExists(ExpandConstant(
    '{localappdata}\Programs\terminal-browser\cli\dist\main.js'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if WizardIsTaskSelected('addtopath') then
      AddToUserPath(ExpandConstant('{app}\bin'));
    if not HasBrowser then
      SuppressibleMsgBox(CustomMessage('NeedsBrowser'), mbInformation, MB_OK, IDOK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveFromUserPath(ExpandConstant('{app}\bin'));
end;
