import { useRef, useEffect } from "react";

type VideoComponentProps = {
  isVisible: boolean;
  mediaStream: MediaStream | null;
};

const VideoComponent: React.FC<VideoComponentProps> = ({
  isVisible,
  mediaStream,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) {
      if (mediaStream) {
        videoRef.current.srcObject = mediaStream;
      } else {
        videoRef.current.srcObject = null;
      }
    }
  }, [mediaStream, isVisible]);

  if (!isVisible) return null;

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      className="w-full h-full scale-x-[-1]"
    />
  );
};

export default VideoComponent;
