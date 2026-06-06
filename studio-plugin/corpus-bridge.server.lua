--[[
	corpus-bridge - Roblox Studio Plugin for Corpus (Web App)

	Connects Roblox Studio to the Corpus web app via the bridge server.

	Installation:
	1. Copy this file to your Roblox Plugins folder
	   - Windows: %LOCALAPPDATA%\Roblox\Plugins
	   - Mac: ~/Documents/Roblox/Plugins
	2. Restart Roblox Studio
	3. Enable HTTP requests in Game Settings > Security
	4. Open Corpus in your browser, copy your token
	5. Paste the token in this plugin and click Connect
]]

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local ScriptEditorService = game:GetService("ScriptEditorService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local TweenService = game:GetService("TweenService")
local StudioTestService = game:GetService("StudioTestService")

local PLUGIN_NAME = "corpus-bridge"
local PLUGIN_DISPLAY_NAME = "Corpus"
local PLUGIN_VERSION = "1.0.0"
local DEFAULT_BRIDGE = "http://127.0.0.1:3001"
local MAX_ACTIVITY_LOG = 10

local function getBridgeBase()
	local saved = plugin:GetSetting("BridgeUrl")
	if type(saved) == "string" and #saved > 0 then
		return saved:gsub("/+$", "")
	end
	return DEFAULT_BRIDGE
end

local function getToken()
	local saved = plugin:GetSetting("StudioToken")
	if type(saved) == "string" and #saved > 0 then
		return saved
	end
	return ""
end

local function setToken(token)
	plugin:SetSetting("StudioToken", token)
end

local function getPollUrl()
	return getBridgeBase() .. "/studio/poll?pluginVersion=" .. PLUGIN_VERSION .. "&capabilities=tool-protocol-v1"
end

local function getRespondUrl()
	return getBridgeBase() .. "/studio/respond"
end

-- State
local isConnected = false
local isConnecting = false
local pollingEnabled = false
local isProcessing = false
local projectInfo = nil
local activityLog = {}

-- UI Elements
local toolbar = plugin:CreateToolbar(PLUGIN_DISPLAY_NAME)
local toggleButton = toolbar:CreateButton(
	PLUGIN_DISPLAY_NAME,
	"Connect to Corpus AI",
	"rbxassetid://4458901886"
)

-- Declare tokenInput here so it's accessible to toggleConnection
local tokenInput

-- Colors (Studio-native dark theme)
local Colors = {
	bg = Color3.fromRGB(13, 16, 21),
	bgSecondary = Color3.fromRGB(20, 24, 31),
	bgTertiary = Color3.fromRGB(29, 35, 44),
	panel = Color3.fromRGB(23, 28, 36),
	panelElevated = Color3.fromRGB(31, 37, 47),
	input = Color3.fromRGB(14, 18, 24),
	accent = Color3.fromRGB(0, 170, 255),
	accentHover = Color3.fromRGB(38, 190, 255),
	accentSoft = Color3.fromRGB(31, 72, 97),
	violet = Color3.fromRGB(124, 92, 255),
	success = Color3.fromRGB(48, 209, 88),
	warning = Color3.fromRGB(255, 190, 64),
	error = Color3.fromRGB(255, 84, 84),
	text = Color3.fromRGB(239, 244, 250),
	textSecondary = Color3.fromRGB(182, 194, 207),
	textMuted = Color3.fromRGB(116, 130, 147),
	border = Color3.fromRGB(48, 57, 70),
	borderStrong = Color3.fromRGB(70, 84, 102),
	processing = Color3.fromRGB(77, 163, 255),
}

-- Widget UI
local widget
local statusDot
local statusText
local subText
local statusPill
local connectButton
local bridgeInput
local activityContainer
local activityList
local activityEmptyState
local processingIndicator
local tokenStatusText
local bridgeStatusText
local versionStatusText

-- Utility: Create rounded frame
local function createFrame(props)
	local frame = Instance.new("Frame")
	frame.BackgroundColor3 = props.bg or Colors.bg
	frame.BorderSizePixel = 0
	frame.Size = props.size or UDim2.new(1, 0, 0, 40)
	frame.Position = props.position or UDim2.new(0, 0, 0, 0)
	frame.BackgroundTransparency = props.transparency or 0
	frame.ClipsDescendants = props.clips or false

	if props.corner then
		local corner = Instance.new("UICorner")
		corner.CornerRadius = UDim.new(0, props.corner)
		corner.Parent = frame
	end

	if props.stroke then
		local stroke = Instance.new("UIStroke")
		stroke.Color = props.strokeColor or Colors.border
		stroke.Thickness = props.strokeThickness or 1
		stroke.Transparency = props.strokeTransparency or 0
		stroke.Parent = frame
	end

	if props.padding then
		local padding = Instance.new("UIPadding")
		padding.PaddingTop = UDim.new(0, props.padding)
		padding.PaddingBottom = UDim.new(0, props.padding)
		padding.PaddingLeft = UDim.new(0, props.padding)
		padding.PaddingRight = UDim.new(0, props.padding)
		padding.Parent = frame
	end

	if props.parent then
		frame.Parent = props.parent
	end

	return frame
end

-- Utility: Create text label
local function createLabel(props)
	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Size = props.size or UDim2.new(1, 0, 0, 20)
	label.Position = props.position or UDim2.new(0, 0, 0, 0)
	label.TextColor3 = props.color or Colors.text
	label.Text = props.text or ""
	label.TextSize = props.textSize or 14
	label.Font = props.font or Enum.Font.GothamMedium
	label.TextXAlignment = props.align or Enum.TextXAlignment.Left
	label.TextYAlignment = props.yAlign or Enum.TextYAlignment.Center
	label.TextTruncate = Enum.TextTruncate.AtEnd
	label.TextWrapped = props.wrapped or false
	if props.autoSize then
		label.AutomaticSize = props.autoSize
	end

	if props.parent then
		label.Parent = props.parent
	end

	return label
end

local function setButtonStyle(button, bg, hover, textColor)
	button:SetAttribute("CorpusBg", bg)
	button:SetAttribute("CorpusHover", hover or bg)
	button.BackgroundColor3 = bg
	if textColor then
		button.TextColor3 = textColor
	end
end

-- Utility: Create button
local function createButton(props)
	local button = Instance.new("TextButton")
	button.BackgroundColor3 = props.bg or Colors.accent
	button.BorderSizePixel = 0
	button.Size = props.size or UDim2.new(1, 0, 0, 36)
	button.Position = props.position or UDim2.new(0, 0, 0, 0)
	button.TextColor3 = props.textColor or Color3.fromRGB(255, 255, 255)
	button.Text = props.text or "Button"
	button.TextSize = props.textSize or 14
	button.Font = props.font or Enum.Font.GothamBold
	button.AutoButtonColor = false

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, props.corner or 10)
	corner.Parent = button

	local stroke = Instance.new("UIStroke")
	stroke.Color = props.strokeColor or Color3.fromRGB(255, 255, 255)
	stroke.Transparency = props.strokeTransparency or 0.85
	stroke.Thickness = 1
	stroke.Parent = button

	setButtonStyle(button, props.bg or Colors.accent, props.bgHover or Colors.accentHover, props.textColor or Color3.fromRGB(255, 255, 255))

	-- Hover effect
	button.MouseEnter:Connect(function()
		TweenService:Create(button, TweenInfo.new(0.15), {
			BackgroundColor3 = button:GetAttribute("CorpusHover")
		}):Play()
	end)

	button.MouseLeave:Connect(function()
		TweenService:Create(button, TweenInfo.new(0.15), {
			BackgroundColor3 = button:GetAttribute("CorpusBg")
		}):Play()
	end)

	if props.parent then
		button.Parent = props.parent
	end

	return button
end

local function createTextBox(props)
	local box = Instance.new("TextBox")
	box.Size = props.size or UDim2.new(1, 0, 0, 38)
	box.Position = props.position or UDim2.new(0, 0, 0, 0)
	box.BackgroundColor3 = props.bg or Colors.input
	box.TextColor3 = props.color or Colors.text
	box.PlaceholderText = props.placeholder or ""
	box.PlaceholderColor3 = Colors.textMuted
	box.Text = props.text or ""
	box.Font = props.font or Enum.Font.Gotham
	box.TextSize = props.textSize or 12
	box.TextXAlignment = Enum.TextXAlignment.Left
	box.ClearTextOnFocus = false
	box.BorderSizePixel = 0

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, props.corner or 10)
	corner.Parent = box

	local stroke = Instance.new("UIStroke")
	stroke.Color = Colors.border
	stroke.Thickness = 1
	stroke.Parent = box

	local pad = Instance.new("UIPadding")
	pad.PaddingLeft = UDim.new(0, 12)
	pad.PaddingRight = UDim.new(0, 12)
	pad.Parent = box

	box.Focused:Connect(function()
		stroke.Color = Colors.accent
	end)

	box.FocusLost:Connect(function()
		stroke.Color = Colors.border
	end)

	if props.parent then
		box.Parent = props.parent
	end

	return box
end

local function createSectionTitle(parent, text, order)
	local label = createLabel({
		text = string.upper(text),
		color = Colors.textMuted,
		textSize = 10,
		font = Enum.Font.GothamBold,
		size = UDim2.new(1, 0, 0, 14),
		parent = parent
	})
	label.LayoutOrder = order
	return label
end

local function createStatusRow(parent, labelText, valueText, order)
	local row = createFrame({
		bg = Colors.panelElevated,
		size = UDim2.new(1, 0, 0, 34),
		corner = 8,
		stroke = true,
		strokeTransparency = 0.4,
		parent = parent
	})
	row.LayoutOrder = order

	createLabel({
		text = labelText,
		color = Colors.textMuted,
		textSize = 11,
		font = Enum.Font.GothamMedium,
		size = UDim2.new(0, 78, 1, 0),
		position = UDim2.new(0, 10, 0, 0),
		parent = row
	})

	local value = createLabel({
		text = valueText,
		color = Colors.textSecondary,
		textSize = 11,
		font = Enum.Font.Gotham,
		size = UDim2.new(1, -98, 1, 0),
		position = UDim2.new(0, 88, 0, 0),
		parent = row
	})

	return value
end

-- Add activity to log
local function addActivity(action, status, details)
	local entry = {
		time = os.date("%H:%M:%S"),
		action = action,
		status = status,
		details = details or ""
	}

	table.insert(activityLog, 1, entry)

	-- Keep log trimmed
	while #activityLog > MAX_ACTIVITY_LOG do
		table.remove(activityLog)
	end

	-- Update UI
	if activityList then
		-- Clear existing
		for _, child in ipairs(activityList:GetChildren()) do
			if child:IsA("Frame") or child.Name == "EmptyState" then
				child:Destroy()
			end
		end

		-- Add entries
		for i, entry in ipairs(activityLog) do
			local hasDetails = entry.details and entry.details ~= ""
			local row = createFrame({
				bg = Colors.panelElevated,
				size = UDim2.new(1, -4, 0, hasDetails and 54 or 38),
				corner = 9,
				stroke = true,
				strokeTransparency = 0.55,
				parent = activityList
			})
			row.LayoutOrder = i

			local stripe = Instance.new("Frame")
			stripe.Size = UDim2.new(0, 3, 1, -12)
			stripe.Position = UDim2.new(0, 8, 0, 6)
			stripe.BorderSizePixel = 0
			stripe.BackgroundColor3 = entry.status == "success" and Colors.success or
				entry.status == "error" and Colors.error or Colors.processing
			stripe.Parent = row

			local stripeCorner = Instance.new("UICorner")
			stripeCorner.CornerRadius = UDim.new(1, 0)
			stripeCorner.Parent = stripe

			createLabel({
				text = entry.time,
				color = Colors.textMuted,
				textSize = 11,
				font = Enum.Font.RobotoMono,
				size = UDim2.new(0, 58, 0, 18),
				position = UDim2.new(0, 18, 0, 8),
				parent = row
			})

			createLabel({
				text = entry.action,
				color = Colors.text,
				textSize = 12,
				font = Enum.Font.GothamMedium,
				size = UDim2.new(1, -86, 0, 20),
				position = UDim2.new(0, 76, 0, 7),
				parent = row
			})

			if hasDetails then
				createLabel({
					text = tostring(entry.details),
					color = Colors.textMuted,
					textSize = 11,
					font = Enum.Font.Gotham,
					size = UDim2.new(1, -86, 0, 18),
					position = UDim2.new(0, 76, 0, 28),
					parent = row
				})
			end
		end

		if #activityLog == 0 and activityEmptyState then
			activityEmptyState.Parent = activityList
		end
	end
end

local function createWidget()
	local info = DockWidgetPluginGuiInfo.new(
		Enum.InitialDockState.Float,
		true,  -- Initially enabled
		false, -- Override previous state
		360,   -- Width
		540,   -- Height
		320,   -- Min width
		420    -- Min height
	)

	widget = plugin:CreateDockWidgetPluginGui("CorpusBridge", info)
	widget.Title = "Corpus"
	widget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

	local container = createFrame({
		bg = Colors.bg,
		size = UDim2.new(1, 0, 1, 0),
	})
	container.Name = "Container"
	container.Parent = widget

	local body = Instance.new("ScrollingFrame")
	body.Name = "Body"
	body.Size = UDim2.new(1, 0, 1, 0)
	body.BackgroundTransparency = 1
	body.BorderSizePixel = 0
	body.ScrollBarThickness = 4
	body.ScrollBarImageColor3 = Colors.borderStrong
	body.CanvasSize = UDim2.new(0, 0, 0, 0)
	body.AutomaticCanvasSize = Enum.AutomaticSize.Y
	body.Parent = container

	local bodyPadding = Instance.new("UIPadding")
	bodyPadding.PaddingTop = UDim.new(0, 14)
	bodyPadding.PaddingBottom = UDim.new(0, 14)
	bodyPadding.PaddingLeft = UDim.new(0, 14)
	bodyPadding.PaddingRight = UDim.new(0, 14)
	bodyPadding.Parent = body

	local layout = Instance.new("UIListLayout")
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, 12)
	layout.Parent = body

	local header = createFrame({
		bg = Colors.panel,
		size = UDim2.new(1, 0, 0, 112),
		corner = 14,
		stroke = true,
		strokeTransparency = 0.5,
		clips = true,
		parent = body
	})
	header.LayoutOrder = 1

	local headerGradient = Instance.new("UIGradient")
	headerGradient.Color = ColorSequence.new({
		ColorSequenceKeypoint.new(0, Colors.panel),
		ColorSequenceKeypoint.new(0.62, Colors.accentSoft),
		ColorSequenceKeypoint.new(1, Colors.violet),
	})
	headerGradient.Rotation = 18
	headerGradient.Parent = header

	createLabel({
		text = "Corpus",
		color = Colors.text,
		textSize = 24,
		font = Enum.Font.GothamBold,
		size = UDim2.new(1, -118, 0, 32),
		position = UDim2.new(0, 16, 0, 15),
		parent = header
	})

	createLabel({
		text = "Roblox Studio bridge",
		color = Colors.textSecondary,
		textSize = 12,
		font = Enum.Font.GothamMedium,
		size = UDim2.new(1, -32, 0, 18),
		position = UDim2.new(0, 16, 0, 48),
		parent = header
	})

	createLabel({
		text = "Paste a Studio token, connect once, then build from the web app or Discord.",
		color = Colors.textMuted,
		textSize = 11,
		font = Enum.Font.Gotham,
		size = UDim2.new(1, -32, 0, 32),
		position = UDim2.new(0, 16, 0, 72),
		wrapped = true,
		yAlign = Enum.TextYAlignment.Top,
		parent = header
	})

	statusPill = createLabel({
		text = "Offline",
		color = Colors.text,
		textSize = 11,
		font = Enum.Font.GothamBold,
		align = Enum.TextXAlignment.Center,
		size = UDim2.new(0, 76, 0, 24),
		position = UDim2.new(1, -92, 0, 16),
		parent = header
	})
	statusPill.BackgroundTransparency = 0
	statusPill.BackgroundColor3 = Colors.error

	local pillCorner = Instance.new("UICorner")
	pillCorner.CornerRadius = UDim.new(1, 0)
	pillCorner.Parent = statusPill

	local statusCard = createFrame({
		bg = Colors.panel,
		size = UDim2.new(1, 0, 0, 92),
		corner = 12,
		stroke = true,
		strokeTransparency = 0.35,
		parent = body
	})
	statusCard.LayoutOrder = 2

	statusDot = Instance.new("Frame")
	statusDot.Name = "Dot"
	statusDot.Size = UDim2.new(0, 12, 0, 12)
	statusDot.Position = UDim2.new(0, 17, 0, 18)
	statusDot.BackgroundColor3 = Colors.error
	statusDot.BorderSizePixel = 0
	statusDot.Parent = statusCard

	local dotCorner = Instance.new("UICorner")
	dotCorner.CornerRadius = UDim.new(1, 0)
	dotCorner.Parent = statusDot

	local dotGlow = Instance.new("UIStroke")
	dotGlow.Color = Colors.error
	dotGlow.Thickness = 3
	dotGlow.Transparency = 0.72
	dotGlow.Parent = statusDot

	statusText = createLabel({
		text = "Disconnected",
		color = Colors.text,
		textSize = 17,
		font = Enum.Font.GothamBold,
		size = UDim2.new(1, -50, 0, 24),
		position = UDim2.new(0, 38, 0, 12),
		parent = statusCard
	})

	processingIndicator = createLabel({
		text = "",
		color = Colors.processing,
		textSize = 12,
		font = Enum.Font.GothamMedium,
		size = UDim2.new(1, -34, 0, 18),
		position = UDim2.new(0, 17, 0, 62),
		parent = statusCard
	})

	subText = createLabel({
		text = "Paste your token and connect to the bridge.",
		color = Colors.textSecondary,
		textSize = 12,
		font = Enum.Font.Gotham,
		size = UDim2.new(1, -34, 0, 20),
		position = UDim2.new(0, 17, 0, 38),
		parent = statusCard
	})

	createSectionTitle(body, "Setup", 3)

	local tokenLabel = createLabel({
		text = "Studio token",
		color = Colors.textSecondary,
		textSize = 12,
		font = Enum.Font.GothamMedium,
		size = UDim2.new(1, 0, 0, 16),
		parent = body
	})
	tokenLabel.LayoutOrder = 4

	tokenInput = createTextBox({
		text = getToken(),
		placeholder = "Paste token from the Corpus web app",
		font = Enum.Font.RobotoMono,
		textSize = 11,
		parent = body
	})
	tokenInput.LayoutOrder = 5

	tokenInput.FocusLost:Connect(function()
		local t = tokenInput.Text:gsub("^%s*(.-)%s*$", "%1")
		tokenInput.Text = t
		setToken(t)
		if tokenStatusText then
			tokenStatusText.Text = t ~= "" and "Token saved locally in Studio settings." or "Required before connecting."
		end
	end)

	tokenStatusText = createLabel({
		text = getToken() ~= "" and "Token saved locally in Studio settings." or "Required before connecting.",
		color = Colors.textMuted,
		textSize = 11,
		font = Enum.Font.Gotham,
		size = UDim2.new(1, 0, 0, 16),
		parent = body
	})
	tokenStatusText.LayoutOrder = 6

	local bridgeLabel = createLabel({
		text = "Bridge URL",
		color = Colors.textSecondary,
		textSize = 12,
		font = Enum.Font.GothamMedium,
		size = UDim2.new(1, 0, 0, 16),
		parent = body
	})
	bridgeLabel.LayoutOrder = 7

	bridgeInput = createTextBox({
		text = getBridgeBase(),
		placeholder = DEFAULT_BRIDGE,
		textSize = 11,
		parent = body
	})
	bridgeInput.LayoutOrder = 8

	bridgeInput.FocusLost:Connect(function()
		local url = bridgeInput.Text:gsub("/+$", "")
		if #url > 0 then
			plugin:SetSetting("BridgeUrl", url)
			bridgeInput.Text = url
			if bridgeStatusText then
				bridgeStatusText.Text = url
			end
		end
	end)

	connectButton = createButton({
		text = "Connect",
		size = UDim2.new(1, 0, 0, 44),
		corner = 11,
		parent = body
	})
	connectButton.LayoutOrder = 9

	connectButton.MouseButton1Click:Connect(function()
		toggleConnection()
	end)

	createSectionTitle(body, "Connection", 10)

	local connectionCard = createFrame({
		bg = Colors.panel,
		size = UDim2.new(1, 0, 0, 138),
		corner = 12,
		stroke = true,
		strokeTransparency = 0.4,
		padding = 10,
		parent = body
	})
	connectionCard.LayoutOrder = 11

	local connectionLayout = Instance.new("UIListLayout")
	connectionLayout.SortOrder = Enum.SortOrder.LayoutOrder
	connectionLayout.Padding = UDim.new(0, 7)
	connectionLayout.Parent = connectionCard

	bridgeStatusText = createStatusRow(connectionCard, "Bridge", getBridgeBase(), 1)
	versionStatusText = createStatusRow(connectionCard, "Plugin", "v" .. PLUGIN_VERSION, 2)
	createStatusRow(connectionCard, "Polling", "100ms long-poll bridge", 3)

	createSectionTitle(body, "Recent Activity", 12)

	activityContainer = createFrame({
		bg = Colors.panel,
		size = UDim2.new(1, 0, 0, 178),
		corner = 12,
		stroke = true,
		strokeTransparency = 0.4,
		parent = body
	})
	activityContainer.LayoutOrder = 13
	activityContainer.ClipsDescendants = true

	local scrollFrame = Instance.new("ScrollingFrame")
	scrollFrame.Size = UDim2.new(1, -8, 1, -8)
	scrollFrame.Position = UDim2.new(0, 8, 0, 8)
	scrollFrame.BackgroundTransparency = 1
	scrollFrame.BorderSizePixel = 0
	scrollFrame.ScrollBarThickness = 4
	scrollFrame.ScrollBarImageColor3 = Colors.borderStrong
	scrollFrame.CanvasSize = UDim2.new(0, 0, 0, 0)
	scrollFrame.AutomaticCanvasSize = Enum.AutomaticSize.Y
	scrollFrame.Parent = activityContainer

	activityList = Instance.new("Frame")
	activityList.Size = UDim2.new(1, -6, 0, 0)
	activityList.BackgroundTransparency = 1
	activityList.AutomaticSize = Enum.AutomaticSize.Y
	activityList.Parent = scrollFrame

	local activityLayout = Instance.new("UIListLayout")
	activityLayout.SortOrder = Enum.SortOrder.LayoutOrder
	activityLayout.Padding = UDim.new(0, 8)
	activityLayout.Parent = activityList

	activityEmptyState = createLabel({
		text = "No activity yet. Once connected, tool calls and bridge events appear here.",
		color = Colors.textMuted,
		textSize = 12,
		font = Enum.Font.Gotham,
		size = UDim2.new(1, -12, 0, 58),
		align = Enum.TextXAlignment.Center,
		wrapped = true,
		parent = activityList
	})
	activityEmptyState.Name = "EmptyState"
	activityEmptyState.TextYAlignment = Enum.TextYAlignment.Center

	return widget
end

-- Animate processing indicator
local processingDots = 0
local function updateProcessingAnimation()
	if isProcessing and processingIndicator then
		processingDots = (processingDots % 3) + 1
		processingIndicator.Text = "Working" .. string.rep(".", processingDots)
	elseif processingIndicator then
		processingIndicator.Text = ""
	end
end

-- Start processing animation loop
task.spawn(function()
	while true do
		updateProcessingAnimation()
		task.wait(0.4)
	end
end)

-- Animate status dot glow
local function animateDotGlow()
	if not statusDot then return end

	local glow = statusDot:FindFirstChildOfClass("UIStroke")
	if not glow then return end

	-- Pulse animation
	while true do
		if isConnected or isConnecting then
			TweenService:Create(glow, TweenInfo.new(1, Enum.EasingStyle.Sine), {
				Transparency = 0.3
			}):Play()
			task.wait(1)
			TweenService:Create(glow, TweenInfo.new(1, Enum.EasingStyle.Sine), {
				Transparency = 0.8
			}):Play()
			task.wait(1)
		else
			glow.Transparency = 0.7
			task.wait(0.5)
		end
	end
end

task.spawn(animateDotGlow)

local function updateUI()
	if not statusDot or not statusText or not subText or not connectButton then
		return
	end

	local glow = statusDot:FindFirstChildOfClass("UIStroke")
	local tokenValue = tokenInput and tokenInput.Text:gsub("^%s*(.-)%s*$", "%1") or getToken()

	if bridgeStatusText then
		bridgeStatusText.Text = getBridgeBase()
	end

	if versionStatusText then
		versionStatusText.Text = "v" .. PLUGIN_VERSION .. " / tool-protocol-v1"
	end

	if tokenStatusText then
		tokenStatusText.Text = tokenValue ~= "" and "Token saved locally in Studio settings." or "Required before connecting."
		tokenStatusText.TextColor3 = tokenValue ~= "" and Colors.textMuted or Colors.warning
	end

	if isProcessing then
		statusDot.BackgroundColor3 = Colors.processing
		if glow then glow.Color = Colors.processing end
		if statusPill then
			statusPill.Text = "Working"
			statusPill.BackgroundColor3 = Colors.processing
			statusPill.TextColor3 = Colors.text
		end
		statusText.Text = "Working in Studio"
		subText.Text = "Executing a Corpus tool request."
		connectButton.Text = "Disconnect"
		setButtonStyle(connectButton, Colors.error, Color3.fromRGB(255, 105, 105))
	elseif isConnecting then
		statusDot.BackgroundColor3 = Colors.warning
		if glow then glow.Color = Colors.warning end
		if statusPill then
			statusPill.Text = "Connecting"
			statusPill.BackgroundColor3 = Colors.warning
			statusPill.TextColor3 = Colors.bg
		end
		statusText.Text = "Connecting..."
		subText.Text = "Waiting for the bridge to accept this token."
		connectButton.Text = "Cancel"
		setButtonStyle(connectButton, Colors.bgTertiary, Colors.borderStrong)
	elseif isConnected then
		statusDot.BackgroundColor3 = Colors.success
		if glow then glow.Color = Colors.success end
		if statusPill then
			statusPill.Text = "Online"
			statusPill.BackgroundColor3 = Colors.success
			statusPill.TextColor3 = Colors.bg
		end
		statusText.Text = "Connected"
		subText.Text = projectInfo and ("Project: " .. projectInfo) or "Ready for web or Discord commands."
		connectButton.Text = "Disconnect"
		setButtonStyle(connectButton, Colors.error, Color3.fromRGB(255, 105, 105))
	else
		statusDot.BackgroundColor3 = Colors.error
		if glow then glow.Color = Colors.error end
		if statusPill then
			statusPill.Text = "Offline"
			statusPill.BackgroundColor3 = Colors.error
			statusPill.TextColor3 = Colors.text
		end
		statusText.Text = "Disconnected"
		subText.Text = tokenValue ~= "" and "Click Connect to start polling." or "Paste a Studio token to connect."
		connectButton.Text = "Connect"
		setButtonStyle(connectButton, Colors.accent, Colors.accentHover)
	end

	toggleButton:SetActive(isConnected or isConnecting)
end

-- Utility functions
local function jsonEncode(data)
	return HttpService:JSONEncode(data)
end

local function jsonDecode(str)
	return HttpService:JSONDecode(str)
end

local function getInstanceFromPath(path)
	path = tostring(path or ""):match("^%s*(.-)%s*$")
	if path == "" or path == "game" or path == "game." then
		return game
	end
	local parts = string.split(path, ".")
	if #parts < 2 or parts[1] ~= "game" then
		return nil
	end

	local current = game
	for i = 2, #parts do
		local child = current:FindFirstChild(parts[i])
		if not child then
			return nil
		end
		current = child
	end

	return current
end

local function getInstancePath(instance)
	local parts = {}
	local current = instance
	while current and current ~= game do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end
	return "game." .. table.concat(parts, ".")
end

local function instanceToInfo(instance, includeChildren)
	local info = {
		path = getInstancePath(instance),
		name = instance.Name,
		className = instance.ClassName,
	}

	if includeChildren then
		info.children = {}
		for _, child in ipairs(instance:GetChildren()) do
			table.insert(info.children, instanceToInfo(child, false))
		end
	end

	return info
end

-- Request handlers
local handlers = {}

handlers["ping"] = function()
	return { status = "ok", plugin = PLUGIN_NAME }
end

-- ─── Playtest log capture ────────────────────────────────────────────────────
local playLogBuffer = {}
local PLAY_LOG_MAX = 200

local LOG_SEVERITY = {
	[Enum.MessageType.MessageOutput]  = "info",
	[Enum.MessageType.MessageInfo]    = "info",
	[Enum.MessageType.MessageWarning] = "warning",
	[Enum.MessageType.MessageError]   = "error",
}

local LogService = game:GetService("LogService")
LogService.MessageOut:Connect(function(message, messageType)
	if #playLogBuffer >= PLAY_LOG_MAX then table.remove(playLogBuffer, 1) end
	table.insert(playLogBuffer, {
		message  = tostring(message):sub(1, 2000),
		severity = LOG_SEVERITY[messageType] or "info",
		channel  = "output",
		timestamp = tick(),
	})
end)

local function callWithTimeout(callback, timeout, timeoutResult)
	local event = Instance.new("BindableEvent")
	local done = false
	local result = timeoutResult
	local timedOut = false

	task.spawn(function()
		local ok, value = pcall(callback)
		result = ok and value or tostring(value)
		if not done then
			done = true
			event:Fire()
		end
	end)

	task.spawn(function()
		task.wait(timeout)
		if not done then
			done = true
			timedOut = true
			event:Fire()
		end
	end)

	if not done then
		event.Event:Wait()
	end

	event:Destroy()
	return result, timedOut
end

handlers["start_playtest"] = function(data)
	playLogBuffer = {}  -- fresh log window for this cycle
	local mode = (data and data.mode) or "play_solo"
	local result, timedOut = callWithTimeout(function()
		if mode == "run_server" then
			return StudioTestService:ExecuteRunModeAsync({})
		end
		return StudioTestService:ExecutePlayModeAsync({})
	end, 0.1, "Started playtest")
	return { started = true, mode = mode, response = result, async = timedOut }
end

handlers["stop_playtest"] = function()
	-- Best-effort stop; errors are non-fatal
	pcall(function() StudioTestService:EndTest({}) end)
	pcall(function() game:GetService("RunService"):Stop() end)
	return { stopped = true }
end

handlers["get_logs"] = function(data)
	local limit = tonumber(data and data.limit) or 50
	local total = #playLogBuffer
	local from  = math.max(1, total - limit + 1)
	local result = {}
	for i = from, total do result[#result + 1] = playLogBuffer[i] end
	return { logs = result }
end

handlers["get_diagnostics"] = function(data)
	local filter = data and data.scriptPath
	local errors = {}
	for _, entry in ipairs(playLogBuffer) do
		if entry.severity == "error" then
			if not filter or (entry.scriptPath and entry.scriptPath:find(filter, 1, true)) then
				errors[#errors + 1] = entry
			end
		end
	end
	return { diagnostics = errors }
end
-- ─────────────────────────────────────────────────────────────────────────────

-- Simple revision token: length + first 6 chars + last 6 chars (cheap fingerprint for conflict detection)
local function makeRevision(source)
	local len = #source
	local head = source:sub(1, 6):gsub("[^%w]", "_")
	local tail = source:sub(-6):gsub("[^%w]", "_")
	return string.format("%d-%s-%s", len, head, tail)
end

handlers["read_script"] = function(data)
	local instance = getInstanceFromPath(data.path)
	if not instance then
		error("Instance not found: " .. data.path)
	end

	if not instance:IsA("LuaSourceContainer") then
		error("Not a script: " .. data.path)
	end

	local source = ScriptEditorService:GetEditorSource(instance)
	if not source then
		source = instance.Source
	end

	return {
		path = getInstancePath(instance),
		source = source,
		className = instance.ClassName,
		revision = makeRevision(source),
	}
end

handlers["write_script"] = function(data)
	local instance = getInstanceFromPath(data.path)
	if not instance then
		error("Instance not found: " .. data.path)
	end

	if not instance:IsA("LuaSourceContainer") then
		error("Not a script: " .. data.path)
	end

	ChangeHistoryService:SetWaypoint("Corpus: write_script")
	ScriptEditorService:UpdateSourceAsync(instance, function()
		return data.source
	end)
	ChangeHistoryService:SetWaypoint("Corpus: write_script done")

	return {
		path = getInstancePath(instance),
		revision = makeRevision(data.source),
		undoWaypoint = "Corpus: write_script",
	}
end

handlers["edit_script"] = function(data)
	local instance = getInstanceFromPath(data.path)
	if not instance then
		error("Instance not found: " .. data.path)
	end

	if not instance:IsA("LuaSourceContainer") then
		error("Not a script: " .. data.path)
	end

	local source = ScriptEditorService:GetEditorSource(instance)
	if not source then
		source = instance.Source
	end

	local newSource, count = string.gsub(source, data.oldCode, data.newCode)
	if count == 0 then
		error("Code not found in script")
	end

	ChangeHistoryService:SetWaypoint("Corpus: edit_script")
	ScriptEditorService:UpdateSourceAsync(instance, function()
		return newSource
	end)
	ChangeHistoryService:SetWaypoint("Corpus: edit_script done")

	return {
		path = getInstancePath(instance),
		replaced = count,
		revision = makeRevision(newSource),
		undoWaypoint = "Corpus: edit_script",
	}
end

handlers["list_children"] = function(data)
	local instance = getInstanceFromPath(data.path)
	if not instance then
		error("Instance not found: " .. data.path)
	end

	local children = {}

	if data.recursive then
		for _, child in ipairs(instance:GetDescendants()) do
			table.insert(children, instanceToInfo(child, false))
		end
	else
		for _, child in ipairs(instance:GetChildren()) do
			table.insert(children, instanceToInfo(child, false))
		end
	end

	return children
end

handlers["get_properties"] = function(data)
	local instance = getInstanceFromPath(data.path)
	if not instance then
		error("Instance not found: " .. data.path)
	end

	local props = {}
	local commonProps = {"Name", "ClassName", "Parent"}

	if instance:IsA("BasePart") then
		local partProps = {"Position", "Size", "CFrame", "Anchored", "CanCollide", "Transparency", "BrickColor", "Material"}
		for _, p in ipairs(partProps) do
			table.insert(commonProps, p)
		end
	end

	if instance:IsA("GuiObject") then
		local guiProps = {"Position", "Size", "Visible", "BackgroundColor3", "BackgroundTransparency"}
		for _, p in ipairs(guiProps) do
			table.insert(commonProps, p)
		end
	end

	for _, propName in ipairs(commonProps) do
		local success, value = pcall(function()
			return instance[propName]
		end)
		if success then
			table.insert(props, {
				name = propName,
				value = tostring(value),
				type = typeof(value),
			})
		end
	end

	return props
end

handlers["set_property"] = function(data)
	local instance = getInstanceFromPath(data.path)
	if not instance then
		error("Instance not found: " .. data.path)
	end

	local value = data.value

	if value == "true" then
		value = true
	elseif value == "false" then
		value = false
	elseif tonumber(value) then
		value = tonumber(value)
	elseif string.match(value, "^%d+,%s*%d+,%s*%d+$") then
		local parts = string.split(value, ",")
		local a, b, c = tonumber(parts[1]), tonumber(parts[2]), tonumber(parts[3])
		if a and b and c then
			if a <= 255 and b <= 255 and c <= 255 and string.find(data.property, "Color") then
				value = Color3.fromRGB(a, b, c)
			else
				value = Vector3.new(a, b, c)
			end
		end
	elseif string.match(value, "^#%x%x%x%x%x%x$") then
		local r = tonumber(string.sub(value, 2, 3), 16)
		local g = tonumber(string.sub(value, 4, 5), 16)
		local b = tonumber(string.sub(value, 6, 7), 16)
		value = Color3.fromRGB(r, g, b)
	elseif string.match(value, "^Enum%.") then
		local parts = string.split(value, ".")
		if #parts == 3 then
			local enumType = Enum[parts[2]]
			if enumType then
				value = enumType[parts[3]]
			end
		end
	end

	instance[data.property] = value

	return { path = getInstancePath(instance) }
end

handlers["create_instance"] = function(data)
	local parent = getInstanceFromPath(data.parent)
	if not parent then
		error("Parent not found: " .. data.parent)
	end

	local instance = Instance.new(data.className)
	if data.name then
		instance.Name = data.name
	end
	instance.Parent = parent

	return { path = getInstancePath(instance) }
end

handlers["delete_instance"] = function(data)
	local instance = getInstanceFromPath(data.path)
	if not instance then
		error("Instance not found: " .. data.path)
	end

	local path = getInstancePath(instance)
	instance:Destroy()

	return { deleted = path }
end

handlers["clone_instance"] = function(data)
	local instance = getInstanceFromPath(data.path)
	if not instance then
		error("Instance not found: " .. data.path)
	end

	local clone = instance:Clone()

	if data.parent then
		local parent = getInstanceFromPath(data.parent)
		if parent then
			clone.Parent = parent
		else
			error("Parent not found: " .. data.parent)
		end
	else
		clone.Parent = instance.Parent
	end

	return { path = getInstancePath(clone) }
end

handlers["move_instance"] = function(data)
	local instance = getInstanceFromPath(data.path)
	if not instance then
		error("Instance not found: " .. data.path)
	end

	local newParent = getInstanceFromPath(data.newParent)
	if not newParent then
		error("Parent not found: " .. data.newParent)
	end

	instance.Parent = newParent

	return { path = getInstancePath(instance) }
end

handlers["bulk_create"] = function(data)
	local created = {}

	for _, item in ipairs(data.instances) do
		local parent = getInstanceFromPath(item.parent)
		if parent then
			local instance = Instance.new(item.className)
			if item.name then
				instance.Name = item.name
			end
			instance.Parent = parent
			table.insert(created, getInstancePath(instance))
		end
	end

	return { created = created }
end

handlers["bulk_delete"] = function(data)
	local deleted = {}

	for _, path in ipairs(data.paths) do
		local instance = getInstanceFromPath(path)
		if instance then
			local fullPath = getInstancePath(instance)
			instance:Destroy()
			table.insert(deleted, fullPath)
		end
	end

	return { deleted = deleted }
end

handlers["bulk_set_property"] = function(data)
	local updated = 0
	local errors = {}

	for _, op in ipairs(data.operations) do
		local instance = getInstanceFromPath(op.path)
		if not instance then
			table.insert(errors, "Not found: " .. op.path)
		else
			local success, err = pcall(function()
				local value = op.value

				-- Parse value based on type
				if value == "true" then
					value = true
				elseif value == "false" then
					value = false
				elseif tonumber(value) then
					value = tonumber(value)
				elseif string.match(value, "^%d+,%s*%d+,%s*%d+$") then
					local parts = string.split(value, ",")
					local a, b, c = tonumber(parts[1]), tonumber(parts[2]), tonumber(parts[3])
					if a and b and c then
						if a <= 255 and b <= 255 and c <= 255 and string.find(op.property, "Color") then
							value = Color3.fromRGB(a, b, c)
						else
							value = Vector3.new(a, b, c)
						end
					end
				elseif string.match(value, "^#%x%x%x%x%x%x$") then
					local r = tonumber(string.sub(value, 2, 3), 16)
					local g = tonumber(string.sub(value, 4, 5), 16)
					local b = tonumber(string.sub(value, 6, 7), 16)
					value = Color3.fromRGB(r, g, b)
				elseif string.match(value, "^Enum%.") then
					local parts = string.split(value, ".")
					if #parts == 3 then
						local enumType = Enum[parts[2]]
						if enumType then
							value = enumType[parts[3]]
						end
					end
				end

				instance[op.property] = value
			end)

			if success then
				updated = updated + 1
			else
				table.insert(errors, op.path .. "." .. op.property .. ": " .. tostring(err))
			end
		end
	end

	return { updated = updated, errors = errors }
end

handlers["search_instances"] = function(data)
	local root = getInstanceFromPath(data.root or "game")
	if not root then
		error("Root not found: " .. (data.root or "game"))
	end

	local results = {}
	local limit = data.limit or 50

	for _, instance in ipairs(root:GetDescendants()) do
		if #results >= limit then
			break
		end

		local matches = true

		if data.name then
			matches = matches and string.lower(instance.Name):find(string.lower(data.name), 1, true) ~= nil
		end

		if data.className then
			matches = matches and instance.ClassName == data.className
		end

		if matches then
			table.insert(results, instanceToInfo(instance, false))
		end
	end

	return results
end

handlers["get_selection"] = function()
	local selected = Selection:Get()
	local results = {}

	for _, instance in ipairs(selected) do
		table.insert(results, instanceToInfo(instance, false))
	end

	return results
end

handlers["execute_luau"] = function(data)
	local output = {}

	local oldPrint = print
	print = function(...)
		local args = {...}
		local str = ""
		for i, v in ipairs(args) do
			if i > 1 then str = str .. "\t" end
			str = str .. tostring(v)
		end
		table.insert(output, str)
	end

	local success, result = pcall(function()
		local fn, err = loadstring(data.code)
		if not fn then
			error(err)
		end
		return fn()
	end)

	print = oldPrint

	if not success then
		return { output = table.concat(output, "\n"), error = tostring(result) }
	end

	if result ~= nil then
		table.insert(output, tostring(result))
	end

	return { output = table.concat(output, "\n") }
end

-- Asset loading stays detached until the server permission flow approves insertion.
local function loadAssetForReview(assetId)
	assetId = tonumber(assetId)
	if not assetId then
		error("Invalid asset ID: " .. tostring(assetId))
	end

	-- Use InsertService to get the asset
	local InsertService = game:GetService("InsertService")
	local success, model = pcall(function()
		return InsertService:LoadAsset(assetId)
	end)

	if not success then
		-- Try alternative method
		success, model = pcall(function()
			local objects = game:GetObjects("rbxassetid://" .. assetId)
			if objects and #objects > 0 then
				return objects[1]
			end
			error("No objects returned")
		end)
	end

	if not success or not model then
		error("Failed to load asset " .. assetId .. ": " .. tostring(model))
	end

	-- If it's a Model wrapper from InsertService, get the first child
	local actualModel = model
	if model:IsA("Model") and model.Name == "InsertedObjects" then
		local children = model:GetChildren()
		if #children > 0 then
			actualModel = children[1]
		end
	end

	return model, actualModel
end

local function assetSafetySummary(actualModel)
	local scripts = {}
	local risky = {}
	local riskyClasses = {
		RemoteEvent = true,
		RemoteFunction = true,
		BindableEvent = true,
		BindableFunction = true,
		Tool = true,
	}
	local descendants = { actualModel }
	for _, descendant in ipairs(actualModel:GetDescendants()) do
		table.insert(descendants, descendant)
	end
	for _, descendant in ipairs(descendants) do
		if descendant:IsA("LuaSourceContainer") then
			table.insert(scripts, { name = descendant.Name, className = descendant.ClassName })
		elseif riskyClasses[descendant.ClassName] then
			table.insert(risky, { name = descendant.Name, className = descendant.ClassName })
		end
	end
	return scripts, risky
end

handlers["inspect_asset"] = function(data)
	local container, actualModel = loadAssetForReview(data.assetId)
	local scripts, risky = assetSafetySummary(actualModel)
	local result = {
		assetId = tonumber(data.assetId),
		name = actualModel.Name,
		scriptCount = #scripts,
		scripts = scripts,
		riskyDescendantCount = #risky,
		riskyDescendants = risky,
		safeWithoutChanges = #scripts == 0 and #risky == 0,
	}
	container:Destroy()
	return result
end

handlers["insert_asset"] = function(data)
	local parent = getInstanceFromPath(data.parent)
	if not parent then
		error("Parent not found: " .. data.parent)
	end
	local container, actualModel = loadAssetForReview(data.assetId)
	local scripts = assetSafetySummary(actualModel)
	local strippedScripts = 0
	if data.stripScripts == true then
		if actualModel:IsA("LuaSourceContainer") then
			container:Destroy()
			error("Cannot strip scripts when the selected asset is itself a script")
		end
		for _, descendant in ipairs(actualModel:GetDescendants()) do
			if descendant:IsA("LuaSourceContainer") then
				descendant:Destroy()
				strippedScripts = strippedScripts + 1
			end
		end
	end
	actualModel.Parent = parent
	if container ~= actualModel then
		container:Destroy()
	end

	return {
		success = true,
		path = getInstancePath(actualModel),
		name = actualModel.Name,
		scriptCount = #scripts,
		strippedScripts = strippedScripts,
	}
end

-- Tools that modify the game and should create undo waypoints
local modifyingTools = {
	["write_script"] = true,
	["edit_script"] = true,
	["set_property"] = true,
	["create_instance"] = true,
	["delete_instance"] = true,
	["clone_instance"] = true,
	["move_instance"] = true,
	["bulk_create"] = true,
	["bulk_delete"] = true,
	["bulk_set_property"] = true,
	["execute_luau"] = true,
	["insert_asset"] = true,
	["start_playtest"] = true,
	["stop_playtest"] = true,
}

-- Friendly names for activity log
local actionNames = {
	["ping"] = "Ping",
	["read_script"] = "Read Script",
	["write_script"] = "Write Script",
	["edit_script"] = "Edit Script",
	["list_children"] = "List Children",
	["get_properties"] = "Get Properties",
	["set_property"] = "Set Property",
	["create_instance"] = "Create Instance",
	["delete_instance"] = "Delete Instance",
	["clone_instance"] = "Clone Instance",
	["move_instance"] = "Move Instance",
	["bulk_create"] = "Bulk Create",
	["bulk_delete"] = "Bulk Delete",
	["bulk_set_property"] = "Bulk Update",
	["search_instances"] = "Search",
	["get_selection"] = "Get Selection",
	["execute_luau"] = "Run Code",
	["inspect_asset"] = "Inspect Asset",
	["insert_asset"] = "Insert Asset",
	["start_playtest"] = "Start Playtest",
	["stop_playtest"] = "Stop Playtest",
	["get_logs"] = "Get Logs",
	["get_diagnostics"] = "Get Diagnostics",
}

-- Tool call handler: dispatches by tool name, returns { id, result, isError }
local function handleRequest(data)
	local tool = data.tool
	local args = data.arguments or {}

	local handler = handlers[tool]
	if not handler then
		local name = tool and tostring(tool) or "unknown"
		addActivity("Unknown tool: " .. name, "error")
		return {
			id = data.id,
			result = nil,
			isError = true,
			error = "Unknown tool: " .. name,
		}
	end

	local isModifying = modifyingTools[tool]
	if isModifying then
		ChangeHistoryService:SetWaypoint("Corpus: " .. tool)
	end

	isProcessing = true
	updateUI()

	local success, result = pcall(handler, args)

	local actionName = actionNames[tool] or tool
	if success then
		addActivity(actionName, "success")
	else
		addActivity(actionName, "error", tostring(result))
	end

	isProcessing = false
	updateUI()

	if isModifying and success then
		ChangeHistoryService:SetWaypoint("Corpus: " .. tool .. " (done)")
	end

	if success then
		return {
			id = data.id,
			result = result,
			isError = false,
		}
	else
		return {
			id = data.id,
			result = nil,
			isError = true,
			error = tostring(result),
		}
	end
end

-- Polling loop
local function pollServer()
	local failCount = 0
	local maxFails = 10

	while pollingEnabled do
		local token = getToken()
		if token == "" then
			-- No token yet — wait for user to paste one
			task.wait(1)
		else
			local ok, response = pcall(function()
				return HttpService:RequestAsync({
					Url = getPollUrl(),
					Method = "GET",
					Headers = {
						["X-Corpus-Token"] = token,
						["Content-Type"] = "application/json",
					},
				})
			end)

			if ok and response then
				if response.StatusCode == 401 then
					-- Token rejected — stop polling and tell user
					pollingEnabled = false
					isConnected = false
					isConnecting = false
					updateUI()
					addActivity("Invalid token — regenerate in Corpus web app", "error")
					print("[corpus-bridge] Token rejected (401). Paste a fresh token from corpus.com.")
					break
				elseif response.Success then
					if not isConnected then
						isConnected = true
						isConnecting = false
						failCount = 0
						updateUI()
						addActivity("Connected", "success")
						print("[corpus-bridge] Connected to Corpus web app")
					end

					local data = jsonDecode(response.Body)

					if data and data.project then
						projectInfo = data.project
						updateUI()
					end

					if data and data.tool then
						local payload = handleRequest(data)
						pcall(function()
							HttpService:RequestAsync({
								Url = getRespondUrl(),
								Method = "POST",
								Headers = {
									["X-Corpus-Token"] = token,
									["Content-Type"] = "application/json",
								},
								Body = jsonEncode(payload),
							})
						end)
					end
					failCount = 0
				else
					-- Network error or non-2xx (not 401)
					failCount = failCount + 1
					if failCount >= maxFails then
						if isConnected then
							isConnected = false
							isConnecting = true
							projectInfo = nil
							updateUI()
							addActivity("Connection lost — retrying", "error")
							print("[corpus-bridge] Connection lost, retrying...")
						end
					end
				end
			else
				-- pcall itself failed (request threw)
				failCount = failCount + 1
				if failCount >= maxFails and isConnected then
					isConnected = false
					isConnecting = true
					projectInfo = nil
					updateUI()
					addActivity("Bridge unreachable — retrying", "error")
					print("[corpus-bridge] Bridge unreachable, retrying...")
				end
			end

			task.wait(0.1)
		end
	end

	-- Stopped polling
	isConnected = false
	isConnecting = false
	projectInfo = nil
	updateUI()
end

-- Toggle connection
function toggleConnection()
	pollingEnabled = not pollingEnabled

	if pollingEnabled then
		local token = tokenInput and tokenInput.Text:gsub("^%s*(.-)%s*$", "%1") or getToken()
		if token == "" then
			pollingEnabled = false
			addActivity("Enter your Corpus token", "error")
			return
		end
		setToken(token)
		if tokenInput then tokenInput.Text = token end
		isConnecting = true
		updateUI()
		addActivity("Connecting", "pending")
		print("[corpus-bridge] Connecting to", getBridgeBase())
		task.spawn(pollServer)
	else
		isConnected = false
		isConnecting = false
		projectInfo = nil
		updateUI()
		addActivity("Disconnected", "success")
		print("[corpus-bridge] Disconnected")
	end
end

-- Initialize
createWidget()
updateUI()

toggleButton.Click:Connect(toggleConnection)

toggleButton.Click:Connect(function()
	widget.Enabled = true
end)

-- Auto-connect if token is already stored
local savedToken = getToken()
if savedToken ~= "" then
	print("[corpus-bridge] Token found, connecting automatically...")
	toggleConnection()
else
	print("[corpus-bridge] Plugin loaded - Paste your Corpus token and click Connect")
end
