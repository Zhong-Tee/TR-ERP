import { Font } from '@react-pdf/renderer'

Font.register({
  family: 'Sarabun',
  fonts: [
    { src: '/fonts/Sarabun-Regular.ttf', fontWeight: 'normal' },
    { src: '/fonts/Sarabun-Bold.ttf', fontWeight: 'bold' },
    { src: '/fonts/Sarabun-Italic.ttf', fontStyle: 'italic' },
    {
      src: '/fonts/Sarabun-BoldItalic.ttf',
      fontWeight: 'bold',
      fontStyle: 'italic',
    },
  ],
})

// Disable hyphenation for Thai text
Font.registerHyphenationCallback((word) => [word])
