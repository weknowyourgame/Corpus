import { cn } from "@/lib/utils";

const logo = "/corpus/assets/logo_transparent_bg.png";

export function CorpusLogo({ large = false, className }: { large?: boolean; className?: string }) {
  return (
    <span className={cn("corpus-logo", className)}>
      <img src={logo} alt="Corpus" className={large ? "corpus-logo-img-lg" : ""} />
      <span>CORPUS</span>
    </span>
  );
}

export function CorpusLogoMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <img
      src={logo}
      alt="Corpus"
      width={size}
      height={size}
      className={cn("object-contain", className)}
    />
  );
}
