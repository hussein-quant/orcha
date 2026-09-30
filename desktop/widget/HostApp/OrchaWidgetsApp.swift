import SwiftUI

@main
struct OrchaWidgetsApp: App {
  var body: some Scene {
    WindowGroup {
      VStack(spacing: 14) {
        Text("Quorate Widgets").font(.title2).bold()
        Text("""
        This app hosts the Quorate desktop widget. Add it from the widget \
        gallery: right-click the desktop → Edit Widgets → search "Quorate". \
        Data comes from the Quorate desktop app — keep it running.
        """)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 420)
      }
      .padding(40)
    }
  }
}
