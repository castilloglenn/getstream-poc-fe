type ButtonComponentProps = {
  onClick: () => void;
  isVideoVisible: boolean;
};

const ButtonComponent: React.FC<ButtonComponentProps> = ({
  onClick,
  isVideoVisible,
}) => {
  return (
    <button
      onClick={onClick}
      className="px-5 py-2.5 text-lg mb-5 cursor-pointer bg-blue-500 text-white border-none rounded-md"
    >
      {isVideoVisible ? "Hide Video" : "Show Video"}
    </button>
  );
};

export default ButtonComponent;
