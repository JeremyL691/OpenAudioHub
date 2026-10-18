// Applies the saved theme before the first paint to avoid a flash.
try {
    const t = localStorage.getItem("theme");
    const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
} catch {}
