import Image from "next/image";
import { initial } from "./initial";

export function Poster({
  path,
  name,
  large = false,
  sizes,
}: {
  path: string | null;
  name: string;
  large?: boolean;
  sizes?: string;
}) {
  return (
    <div className={`poster ${large ? "large" : ""}`}>
      {path ? (
        <Image
          src={`https://image.tmdb.org/t/p/w342${path}`}
          alt={`${name} poster`}
          fill
          sizes={sizes ?? (large ? "180px" : "72px")}
        />
      ) : (
        <span aria-hidden="true">{initial(name)}</span>
      )}
    </div>
  );
}
