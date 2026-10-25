' Uruchamia serwer Odkrywcy parków w tle (bez okna konsoli).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node server.js --no-open", 0, False
