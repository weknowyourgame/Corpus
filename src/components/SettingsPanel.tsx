import { useSettingsStore } from "@/stores/settings";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Settings, Palette, RotateCcw } from "lucide-react";
import { ALL_TIERS, TIER_LABELS, TIER_DESCRIPTIONS } from "@/lib/ai/profiles";
import type { Tier } from "@/lib/ai/profiles";
import { cn } from "@/lib/utils";

interface SettingsPanelProps {
  trigger?: React.ReactNode;
}

export function SettingsPanel({ trigger }: SettingsPanelProps) {
  const { selectedTier, setTier, appSettings, updateAppSettings, resetAppSettings } = useSettingsStore();

  return (
    <Sheet>
      <SheetTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Settings className="w-4 h-4" />
          </Button>
        )}
      </SheetTrigger>
      <SheetContent className="w-[400px] sm:w-[540px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-heading">Settings</SheetTitle>
          <SheetDescription>
            Configure <span className="font-logo">Stud</span> to your preferences
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="tier" className="mt-6">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="tier" className="gap-1.5">
              AI Tier
            </TabsTrigger>
            <TabsTrigger value="ui" className="gap-1.5">
              <Palette className="w-3.5 h-3.5" />
              Interface
            </TabsTrigger>
          </TabsList>

          <TabsContent value="tier" className="mt-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              AI credentials are configured server-side in <code>.env</code>.
            </p>
            {ALL_TIERS.map((tier: Tier) => (
              <button
                key={tier}
                type="button"
                onClick={() => setTier(tier)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-3 rounded-xl border text-left transition-all",
                  selectedTier === tier
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40 hover:bg-muted/50"
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{TIER_LABELS[tier]}</span>
                    {selectedTier === tier && (
                      <span className="text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">Active</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{TIER_DESCRIPTIONS[tier]}</p>
                </div>
              </button>
            ))}
          </TabsContent>

          <TabsContent value="ui" className="mt-4 space-y-4">
            <SettingToggle
              label="Animations"
              description="Enable smooth animations and transitions"
              checked={appSettings.animationsEnabled}
              onCheckedChange={(checked) => updateAppSettings({ animationsEnabled: checked })}
            />
            <SettingToggle
              label="Show Tool Details"
              description="Display expanded tool call information"
              checked={appSettings.showToolDetails}
              onCheckedChange={(checked) => updateAppSettings({ showToolDetails: checked })}
            />
            <SettingToggle
              label="Auto-scroll Chat"
              description="Automatically scroll to new messages"
              checked={appSettings.autoScrollChat}
              onCheckedChange={(checked) => updateAppSettings({ autoScrollChat: checked })}
            />
            <SettingToggle
              label="Confirm Destructive Actions"
              description="Ask before deleting instances or scripts"
              checked={appSettings.confirmDestructiveActions}
              onCheckedChange={(checked) => updateAppSettings({ confirmDestructiveActions: checked })}
            />
            <div className="pt-4 border-t">
              <Button variant="outline" onClick={resetAppSettings} className="w-full gap-2">
                <RotateCcw className="w-4 h-4" />
                Reset to Defaults
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        <div className="mt-8 pt-6 border-t">
          <h3 className="text-sm font-medium mb-3">Keyboard Shortcuts</h3>
          <div className="space-y-2 text-xs">
            <ShortcutRow keys={["⌘", "Enter"]} description="Send message" />
            <ShortcutRow keys={["⌘", "K"]} description="Clear chat" />
            <ShortcutRow keys={["⌘", ","]} description="Open settings" />
            <ShortcutRow keys={["Esc"]} description="Cancel / Close" />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SettingToggle({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function ShortcutRow({ keys, description }: { keys: string[]; description: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{description}</span>
      <div className="flex items-center gap-1">
        {keys.map((key, i) => (
          <kbd key={i} className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono border">
            {key}
          </kbd>
        ))}
      </div>
    </div>
  );
}

export default SettingsPanel;
