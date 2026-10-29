import { Link } from 'react-router-dom'

/** The Recall mark: a pie with one lime slice pulled out. Exactly the approved reference. */
export function Mark({ muted = false }: { muted?: boolean }) {
  if (muted) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 12 L18.364 5.636 A9 9 0 1 1 12 3 Z" fill="#6e6e73" />
        <g stroke="#151517" strokeWidth="1.3">
          <path d="M3 12h18M12 3v18M5.636 5.636l12.728 12.728M18.364 5.636 5.636 18.364" />
        </g>
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 12 L18.364 5.636 A9 9 0 1 1 12 3 Z" fill="#f5f5f7" />
      <g stroke="#0a0a0b" strokeWidth="1.1">
        <path d="M3 12h18M12 3v18M5.636 5.636l12.728 12.728M18.364 5.636 5.636 18.364" />
      </g>
      <path d="M12 12 L12 3 A9 9 0 0 1 18.364 5.636 Z" fill="#c8f04f" transform="translate(.9 -2.1)" />
    </svg>
  )
}

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="Recall home">
      <Mark />
      Recall
    </Link>
  )
}
