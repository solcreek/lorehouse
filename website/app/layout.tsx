// The root layout: the SVG filters every page draws with, then the page.
//   #stamp  breaks up rubber-stamp ink
//   #pencil wobbles and grains a line like a pencil on paper
function Filters() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <filter id="stamp" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves={2} seed={11} result="n" />
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.5" result="holes" />
        <feComposite in="SourceGraphic" in2="holes" operator="in" />
      </filter>
      <filter id="pencil" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency=".05" numOctaves={2} seed={8} result="w" />
        <feDisplacementMap in="SourceGraphic" in2="w" scale={3} xChannelSelector="R" yChannelSelector="G" result="d" />
        <feTurbulence type="fractalNoise" baseFrequency="1.2" numOctaves={1} seed={1} result="g" />
        <feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 1.4" result="grain" />
        <feComposite in="d" in2="grain" operator="in" />
      </filter>
    </svg>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Filters />
      {children}
    </>
  );
}
