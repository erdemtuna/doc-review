import { brandIconDataUri } from "../brand.generated";

export function Brand() {
  return <img className="brand-mark" src={brandIconDataUri} alt="Doc Review"
    width={32} height={32} draggable={false} />;
}
