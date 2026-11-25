"""Package the Antigravity Offline SSH extension into a Marketplace-ready .vsix archive."""

from __future__ import annotations

import json
import pathlib
import zipfile
from xml.sax.saxutils import escape

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
NLS = json.loads((ROOT / "package.nls.json").read_text(encoding="utf-8"))


def resolve_nls(val: str) -> str:
    if val.startswith("%") and val.endswith("%"):
        return NLS.get(val[1:-1], val)
    return val


PUBLISHER = PKG["publisher"]
NAME = PKG["name"]
VERSION = PKG["version"]
DISPLAY_NAME = resolve_nls(PKG["displayName"])
DESCRIPTION = resolve_nls(PKG["description"])
ENGINE_VSCODE = PKG["engines"]["vscode"]
KEYWORDS = ",".join(PKG.get("keywords", []))
BANNER_COLOR = PKG.get("galleryBanner", {}).get("color", "#0F172A")
BANNER_THEME = PKG.get("galleryBanner", {}).get("theme", "dark")

OUT_VSIX = ROOT / f"{NAME}-{VERSION}.vsix"

CONTENT_TYPES_XML = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>
"""

MANIFEST_XML = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(NAME)}" Version="{escape(VERSION)}" Publisher="{escape(PUBLISHER)}" />
    <DisplayName>{escape(DISPLAY_NAME)}</DisplayName>
    <Description xml:space="preserve">{escape(DESCRIPTION)}</Description>
    <Tags>{escape(KEYWORDS)}</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(ENGINE_VSCODE)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="{escape(BANNER_COLOR)}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="{escape(BANNER_THEME)}" />
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/media/logo.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/logo.png" Addressable="true" />
  </Assets>
</PackageManifest>
"""

INCLUDE_FILES = [
    "package.json",
    "package.nls.json",
    "package.nls.zh-cn.json",
    "README.md",
    "LICENSE",
    "media/icon.svg",
    "media/logo.png",
    "src/extension.js",
    "src/sshConfig.js",
    "src/serverInfo.js",
    "src/downloader.js",
    "src/agyInstaller.js",
    "src/sshRunner.js",
    "src/proxyTunnel.js",
]


def main() -> None:
    with zipfile.ZipFile(OUT_VSIX, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", CONTENT_TYPES_XML)
        zf.writestr("extension.vsixmanifest", MANIFEST_XML)
        for rel in INCLUDE_FILES:
            src_file = ROOT / rel
            zf.write(src_file, arcname=f"extension/{rel}")
    print(f"Created {OUT_VSIX} ({OUT_VSIX.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
