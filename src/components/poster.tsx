import Image from "next/image";

export function Poster({
  path,
  name,
  large = false,
}: {
  path: string | null;
  name: string;
  large?: boolean;
}) {
  return (
    <div className={`poster ${large ? "large" : ""}`}>
      {path ? (
        <Image
          src={`https://image.tmdb.org/t/p/w342${path}`}
          alt={`${name} poster`}
          fill
          sizes={large ? "180px" : "72px"}
        />
      ) : (
        <span aria-hidden="true">{name.slice(0, 1)}</span>
      )}
    </div>
  );
}
