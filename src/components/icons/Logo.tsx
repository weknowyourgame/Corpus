import { CorpusLogo, CorpusLogoMark } from "@/corpus-ui";
import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  large?: boolean;
}

export function LogoMark({ className, size }: { className?: string; size?: number }) {
  return <CorpusLogoMark className={className} size={size} />;
}

export function Logo({ className, large }: LogoProps) {
  return <CorpusLogo className={cn(className)} large={large} />;
}

export function LogoSplash({ className }: LogoProps) {
  return <CorpusLogo large className={cn(className)} />;
}

export default Logo;
