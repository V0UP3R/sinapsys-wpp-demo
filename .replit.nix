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
  ];
}