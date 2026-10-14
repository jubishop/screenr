import Foundation
import Sentry

// Sentry's last look at everything it sends, as its beforeSend, beforeBreadcrumb,
// beforeSendSpan, and beforeSendLog callbacks. Sentry is configured to collect no personal data,
// so these remove anything that slips through anyway: the user keeps only the opaque Screenr user
// ID, every URL becomes its route pattern, breadcrumbs keep only data that names no content, and
// exceptions keep their type and code but not their message.
enum SentryPrivacy {
  // Breadcrumb data that names no member or content: Sentry's lifecycle, device, and network
  // fields, and Telemetry's request fields. Titles, view descriptions, and accessibility
  // identifiers from Sentry's touch and screen breadcrumbs are dropped.
  private static let breadcrumbKeys: Set<String> = [
    "action", "beingPresented", "charging", "connectivity", "duration_ms", "level", "method",
    "orientation", "parentViewController", "reason", "request_body_size", "request_id",
    "response_body_size", "screen", "state", "status_code",
  ]
  private static let urlKeys: Set<String> = ["url", "to", "from"]
  private static let spanDataDropped: Set<String> = ["http.query", "http.fragment"]
  private static let logAttributesDropped: Set<String> = [
    "user.name", "user.email", "user.username", "user.ip_address",
  ]

  static func scrub(_ event: Event) -> Event {
    var user: User?
    if let id = event.user?.userId {
      user = User(userId: id)
    }
    event.user = user
    if let request = event.request {
      let scrubbed = SentryRequest()
      if let url = request.url { scrubbed.url = reduce(url) }
      scrubbed.method = request.method
      scrubbed.bodySize = request.bodySize
      event.request = scrubbed
    }
    event.serverName = nil
    event.message = nil
    if var context = event.context {
      // A captured error's user info can hold URLs and messages.
      context["user info"] = nil
      if var device = context["device"] {
        device["name"] = nil
        context["device"] = device
      }
      event.context = context
    }
    for exception in event.exceptions ?? [] {
      scrub(exception)
    }
    event.breadcrumbs = event.breadcrumbs?.compactMap(scrub)
    return event
  }

  // A captured error keeps its domain, as the exception type, and its code. Its description, user
  // info, and debug description can hold content, as can a Swift error's associated values.
  // Crash and hang reasons come from the system and stay, with their URLs reduced.
  private static func scrub(_ exception: Exception) {
    guard let mechanism = exception.mechanism, mechanism.type == "NSError" else {
      if let value = exception.value {
        exception.value = RoutePattern.reducingURLs(in: value)
      }
      return
    }
    exception.value = "Code: \(mechanism.meta?.error?.code ?? 0)"
    mechanism.desc = nil
    mechanism.data = nil
  }

  static func scrub(_ breadcrumb: Breadcrumb) -> Breadcrumb? {
    if let message = breadcrumb.message {
      breadcrumb.message = RoutePattern.reducingURLs(in: message)
    }
    for (key, value) in breadcrumb.data ?? [:] {
      if urlKeys.contains(key), let url = value as? String {
        breadcrumb.setData(value: reduce(url), key: key)
      } else if !breadcrumbKeys.contains(key) {
        breadcrumb.setData(value: nil, key: key)
      }
    }
    return breadcrumb
  }

  static func scrub(_ span: any Span) -> (any Span)? {
    if let description = span.spanDescription {
      span.spanDescription = RoutePattern.reducingURLs(in: description)
    }
    for (key, value) in span.data {
      if spanDataDropped.contains(key) {
        span.removeData(key: key)
      } else if key == "url", let url = value as? String {
        span.setData(value: reduce(url), key: key)
      }
    }
    return span
  }

  static func scrub(_ log: SentryLog) -> SentryLog? {
    for key in logAttributesDropped {
      log.setAttribute(nil, forKey: key)
    }
    return log
  }

  private static func reduce(_ url: String) -> String {
    if url.hasPrefix("/") { return RoutePattern(path: url).value }
    guard let parsed = URL(string: url) else { return ":url" }
    return RoutePattern(url: parsed).value
  }
}
