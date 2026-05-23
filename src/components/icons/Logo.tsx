import { StudLogo, StudLogoMark } from "@/stud-ui";
import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  large?: boolean;
}

export function LogoMark({ className, size }: { className?: string; size?: number }) {
  return <StudLogoMark className={className} size={size} />;
}

export function Logo({ className, large }: LogoProps) {
  return <StudLogo className={cn(className)} large={large} />;
}

export function LogoSplash({ className }: LogoProps) {
  return <StudLogo large className={cn(className)} />;
}

export default Logo;
