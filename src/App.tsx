import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { PrereqWizard } from "@/components/prereq/PrereqWizard";
import Home from "@/pages/Home";

function App() {
  return (
    <div className="corpus-page corpus-body">
      <TooltipProvider>
        <PrereqWizard />
        <Home />
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
    </div>
  );
}

export default App;
