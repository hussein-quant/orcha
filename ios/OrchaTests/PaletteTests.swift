import Foundation
import SwiftUI
import Testing
@testable import Orcha

/// `SkinMode` raw-value contract (shared vocabulary with the web/portal —
/// classic|swiss|minimal, exactly the iOS raw values) and `Palette.current`
/// completeness across every skin × theme-mode combination.

@Suite struct SkinModeTests {

    @Test func rawValueRoundTripsForEveryCase() {
        for skin in SkinMode.allCases {
            #expect(SkinMode(rawValue: skin.rawValue) == skin)
        }
    }

    @Test func minimalRawValueMatchesTheWebPrefValueExactly() {
        // The web writes/reads the literal scalar "minimal" (mig 040 prefs bag).
        #expect(SkinMode.minimal.rawValue == "minimal")
        #expect(SkinMode(rawValue: "minimal") == .minimal)
    }

    @Test func everyCaseHasADistinctNonEmptyLabelAndBlurb() {
        let labels = SkinMode.allCases.map(\.label)
        #expect(Set(labels).count == SkinMode.allCases.count)
        for skin in SkinMode.allCases {
            #expect(!skin.label.isEmpty)
            #expect(!skin.blurb.isEmpty)
        }
    }

    @Test func minimalDisplaysAsMinimalist() {
        #expect(SkinMode.minimal.label == "Minimalist")
    }
}

@Suite struct PaletteCompletenessTests {

    @Test func everySkinResolvesForBothThemeModesInBothColorSchemes() {
        for skin in SkinMode.allCases {
            for mode in [ThemeMode.dark, .light] {
                for systemDark in [true, false] {
                    let p = Palette.current(mode, skin: skin, systemDark: systemDark)
                    #expect(p.isDark == (mode == .dark))
                }
            }
            // Auto: follows the system flag, both directions.
            #expect(Palette.current(.auto, skin: skin, systemDark: true).isDark)
            #expect(!Palette.current(.auto, skin: skin, systemDark: false).isDark)
        }
    }

    @Test func minimalDarkAndLightAreDistinctPalettesWithCorrectIsDark() {
        #expect(Palette.minimalDark.isDark)
        #expect(!Palette.minimalLight.isDark)
        #expect(Palette.minimalDark.bg != Palette.minimalLight.bg)
        #expect(Palette.minimalDark.text != Palette.minimalLight.text)
    }

    @Test func minimalKeepsFlatChromeAndSystemFontLikeSwiss() {
        // Declutter brief: flat elevation, no brand radial glow — same
        // `flatChrome` gate `OrchaThemed` already uses for Swiss.
        #expect(Palette.minimalDark.flatChrome)
        #expect(Palette.minimalLight.flatChrome)
        // SF Pro substitution for the web's Hanken Grotesk — no bundled font.
        #expect(Palette.minimalDark.displayFamily == nil)
        #expect(Palette.minimalLight.displayFamily == nil)
    }

    @Test func minimalUsesLargerRadiiThanClassicPerWebParity() {
        // Web `.card` grows to 18px, `.btn`/`.tag` to 12px under
        // [data-skin="minimal"] — larger radii read as "decluttered", not sharp
        // like Swiss (which shrinks to near-zero).
        #expect(Palette.minimalDark.radiusCard > Palette.dark.radiusCard)
        #expect(Palette.minimalDark.radiusTag > Palette.dark.radiusTag)
        #expect(!Palette.minimalDark.pillMono)
    }

    @Test func minimalAccentIsTheChampagneGoldFromTheWebSkin() {
        #expect(Palette.minimalDark.accent == Color(hex: 0xE7C368))
        // Light mode darkens gold for AA text/interactive contrast.
        #expect(Palette.minimalLight.accent == Color(hex: 0x96721A))
    }
}
