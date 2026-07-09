export function updateAvatarVideo(video: HTMLVideoElement, fileUrl?: string): void {
  if (!fileUrl) return;

  video.src = fileUrl;
  video.autoplay = true;
  video.muted = true;
  video.loop = true;
  video.controls = true;
  video.playsInline = true;
  video.load();
  void video.play().catch(() => undefined);
}
