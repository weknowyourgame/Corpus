- Fix: When run is cancelled the agent keeps on executing
- Fix: approve scope
- Implement proper playtest AI
- Add postgres to the whole app
- add proper diff
- Fix ui of plugin
- fix chat ui really buggy right now chat many ui bugs
- fix bug: Input

{
  "path": "game.ServerScriptService.DayNightCycle",
  "oldCode": "",
  "newCode": "local Lighting = game:GetService(\"Lighting\")\nlocal RunService = game:GetService(\"RunService\")\nlocal time = 0\nlocal speed = 0.1\nwhile true do\n    time = (time + speed) % 1440\n    Lighting.ClockTime = time / 60\n    if time < 720 then\n        Lighting.Brightness = 2\n        Lighting.Ambient = Color3.fromRGB(150,150,150)\n    else\n        Lighting.Brightness = 0.2\n        Lighting.Ambient = Color3.fromRGB(30,30,50)\n    end\n    task.wait(1)\nend"
}
Error

user_stud-bridge.server.lua.Script:816: invalid use of '%' in replacement string

Write script wont work

- Fix UI when it calls tools and writes scripts mainly ui show proper diffs
- replace raw details with something that looks better
- make no permission mode doesnt not need any allow or reject requests