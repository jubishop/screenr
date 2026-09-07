import Link from "next/link";
export default function Credits() {
  return (
    <main className="auth-page">
      <Link href="/" className="brand">
        screenr<span>●</span>
      </Link>
      <section className="auth-card">
        <h1>Catalog credits</h1>
        <img src="/tmdb.svg" width="120" height="16" alt="TMDB" />
        <p>
          Movie and TV metadata and artwork are provided by{" "}
          <a href="https://www.themoviedb.org/">The Movie Database (TMDB)</a>.
        </p>
        <p>
          This product uses the TMDB API but is not endorsed or certified by
          TMDB.
        </p>
        <Link className="text-button" href="/">
          Back to Screenr →
        </Link>
      </section>
    </main>
  );
}
