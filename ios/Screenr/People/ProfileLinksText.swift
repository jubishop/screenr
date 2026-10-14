import ScreenrKit
import SwiftUI

// People named in a line of text, each name linking to their profile, such
// as "Mutual friends: Ben Ortiz (@ben), Cam Rivera (@cam)". Links in text
// keep the line wrapping as a sentence, where buttons would not, and
// VoiceOver offers them through its links rotor.
struct ProfileLinksText: View {
  var prefix = ""
  let people: [Person]
  let separator: String
  var name: KeyPath<Person, String> = \.displayName
  @Environment(ShellModel.self) private var shell

  var body: some View {
    Text(text)
      .environment(
        \.openURL,
        OpenURLAction { url in
          guard let destination = Destination(url: url) else { return .systemAction }
          shell.router.open(destination)
          return .handled
        }
      )
  }

  private var text: AttributedString {
    var text = AttributedString(prefix)
    for (index, person) in people.enumerated() {
      if index > 0 { text += AttributedString(separator) }
      var link = AttributedString(person[keyPath: name])
      link.link = Destination.profile(username: person.username).shareURL
      text += link
    }
    return text
  }
}
