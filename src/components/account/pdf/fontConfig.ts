import { Font } from '@react-pdf/renderer'

const fontSrc = (name: string) => typeof window === 'undefined'
  ? `${process.cwd()}/public/fonts/${name}`
  : `/fonts/${name}`

Font.register({
  family: 'Sarabun',
  fonts: [
    { src: fontSrc('Sarabun-Regular.ttf'), fontWeight: 'normal' },
    { src: fontSrc('Sarabun-Bold.ttf'), fontWeight: 'bold' },
    { src: fontSrc('Sarabun-Italic.ttf'), fontStyle: 'italic' },
    {
      src: fontSrc('Sarabun-BoldItalic.ttf'),
      fontWeight: 'bold',
      fontStyle: 'italic',
    },
  ],
})

// Disable hyphenation for Thai text
Font.registerHyphenationCallback((word) => [word])
