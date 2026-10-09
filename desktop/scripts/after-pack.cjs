// electron-builder afterPack hook (D-342). Files written inside a File Provider-synced folder carry
// FinderInfo and fileprovider attributes that codesign refuses to sign. The packaging output is kept outside
// that folder, and this hook also clears any attribute that a copy brought along, before signing. It is best
// effort: a dangling symlink makes xattr fail, and codesign still reports any attribute it cannot accept.
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(context) {
    try {
        execFileSync("xattr", ["-cr", context.appOutDir], { stdio: "pipe" });
    } catch (error) {
        console.warn(`xattr cleanup incomplete: ${error.message.split("\n")[0]}`);
    }
};
