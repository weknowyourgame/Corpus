import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Icon } from "@/components/icons/Icon";
import { useSettingsStore } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import { ALL_TIERS, TIER_LABELS, TIER_DESCRIPTIONS } from "@/lib/ai/profiles";
import type { Tier } from "@/lib/ai/profiles";
import { cn } from "@/lib/utils";

function TierCard({ tier, selected, onSelect }: { tier: Tier; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-3 rounded-xl border text-left transition-all",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/40 hover:bg-muted/50"
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{TIER_LABELS[tier]}</span>
          {selected && (
            <span className="text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">Active</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{TIER_DESCRIPTIONS[tier]}</p>
      </div>
    </button>
  );
}

interface SettingsDialogProps {
  children?: React.ReactNode;
}

export function SettingsDialog({ children }: SettingsDialogProps) {
  const { selectedTier, setTier } = useSettingsStore();
  const { user, logout } = useAuthStore();

  return (
    <Dialog>
      <DialogTrigger asChild>
        {children || (
          <button type="button" className="corpus-icon-btn nav-button" aria-label="Settings">
            <Icon name="settings-gear" size="md" />
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>AI Tier</DialogTitle>
          <DialogDescription>
            Choose your AI capability tier. Model access is managed by Corpus.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          {ALL_TIERS.map((tier) => (
            <TierCard
              key={tier}
              tier={tier}
              selected={selectedTier === tier}
              onSelect={() => setTier(tier)}
            />
          ))}
        </div>

        <p className="text-xs text-muted-foreground pt-1">
          Provider credentials are Corpus-owned server configuration and are never entered in the browser.
        </p>

        {user && (
          <div className="border-t pt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Signed in as {user.anonymous ? "anonymous dev user" : user.email}
            </p>
            {!user.anonymous && (
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => void logout()}>
                Sign out
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default SettingsDialog;
