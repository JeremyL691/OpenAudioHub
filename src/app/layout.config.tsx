import type { DocsLayoutProps } from "fumadocs-ui/layouts/docs";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { ArrowLeft } from "lucide-react";
import Image from "next/image";
import { Github } from "@/components/icons/icons";
import { BRAND } from "@/lib/brand";

export const baseOptions: BaseLayoutProps = {
    nav: {
        // The static mark, not the inline LogoMark: the docs shell renders this
        // title twice, and the inline mark's gradient id then resolves to the
        // copy inside the hidden one, which Chromium paints as nothing.
        // `unoptimized` because the image optimizer does not serve SVG by default.
        title: (
            <span className="flex items-center gap-2">
                <Image
                    src="/brand/mark.svg"
                    alt=""
                    aria-hidden="true"
                    width={20}
                    height={20}
                    unoptimized
                    className="size-5 shrink-0"
                />
                OpenAudioHub Docs
            </span>
        ),
        url: "/docs",
    },
    // The GitHub link is built here, not with `githubUrl`: fumadocs' own icon
    // is an untitled svg with role="img", which axe reports. The app's Github
    // icon hides its svg and the link carries the label.
    links: [
        {
            type: "main",
            text: "Back to app",
            url: "/dashboard",
            icon: <ArrowLeft className="size-4" />,
            on: "all",
        },
        {
            type: "icon",
            url: BRAND.repoUrl,
            text: "GitHub",
            label: "GitHub",
            icon: <Github />,
            external: true,
        },
    ],
};

export const docsTabs: NonNullable<DocsLayoutProps["tabs"]> = [
    { title: "Guides", url: "/docs/guides" },
    { title: "Self Hosting", url: "/docs/self-hosting" },
    { title: "Reference", url: "/docs/reference" },
];
