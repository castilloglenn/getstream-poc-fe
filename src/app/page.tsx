"use client";

import { useEffect, useState } from "react";
import VideoComponent from "../components/VideoComponent";
import ButtonComponent from "../components/ButtonComponent";

export default function Home() {
  const [isVideoVisible, setIsVideoVisible] = useState(true);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        setMediaStream(stream);
      } catch (err) {
        console.error("Error accessing the camera:", err);
      }
    };

    startCamera();
  }, []);

  const toggleVideoVisibility = () => {
    setIsVideoVisible((prev) => !prev);
  };

  return (
    <div className="flex flex-col items-center p-5">
      <div className="w-full max-w-xl border-2 border-black rounded-lg overflow-hidden shadow-md h-[500px]">
        <VideoComponent isVisible={isVideoVisible} mediaStream={mediaStream} />
      </div>
      <ButtonComponent
        onClick={toggleVideoVisibility}
        isVideoVisible={isVideoVisible}
      />
    </div>
  );
}
