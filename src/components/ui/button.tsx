import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none",
  {
    variants: {
      variant: {
        default: "btn btn-metal text-[#1a1817]",
        destructive:
          "rounded-md bg-red-600 text-white hover:bg-red-700 px-4 py-2",
        outline: "nav-button text-[#1a1817]",
        secondary: "nav-button bg-white/80 text-[#1a1817]",
        ghost: "nav-button border-transparent shadow-none bg-transparent",
        link: "text-[#1a1817] underline-offset-4 hover:underline px-0",
        dark: "btn btn-dark",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3 min-w-[2.25rem]",
        xs: "h-7 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4 text-[15px]",
        icon: "size-9 p-0",
        "icon-xs": "size-7 p-0 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 p-0",
        "icon-lg": "size-10 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
