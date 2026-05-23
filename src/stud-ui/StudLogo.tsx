import { cn } from "@/lib/utils";

const logo = "/stud/assets/logo_transparent_bg.png";

export function StudLogo({ large = false, className }: { large?: boolean; className?: string }) {
  return (
    <span className={cn("stud-logo", className)}>
      <img src={logo} alt="Stud" className={large ? "stud-logo-img-lg" : ""} />
      <span>STUD</span>
    </span>
  );
}

export function StudLogoMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <img
      src={logo}
      alt="Stud"
      width={size}
      height={size}
      className={cn("object-contain", className)}
    />
  );
}
