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
        // A plain anchor, not a fumadocs link. A client-side route change keeps
        // fumadocs' stylesheet loaded in the app, and its `.hidden` rule then
        // hides the app sidebar.
        {
            type: "custom",
            on: "all",
            children: (
                <a
                    href="/dashboard"
                    className="flex flex-row items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 [&_svg]:size-4 [&_svg]:shrink-0"
                >
                    <ArrowLeft />
                    Back to app
                </a>
            ),
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
