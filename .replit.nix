
{ pkgs }: {
  deps = [
    pkgs.chromium
    pkgs.libwebp
    pkgs.ffmpeg
    pkgs.nodePackages.typescript-language-server
    pkgs.yarn
    pkgs.arcanPackages.ffmpeg
    pkgs.libwebp
    pkgs.imagemagick
    pkgs.git
    pkgs.glib
    pkgs.gtk3
    pkgs.gsettings-desktop-schemas
    pkgs.gdk-pixbuf
    pkgs.cairo
    pkgs.pango
    pkgs.atk
    pkgs.xorg.libX11
    pkgs.xorg.libxcb
    pkgs.gobject-introspection
  ];
}
