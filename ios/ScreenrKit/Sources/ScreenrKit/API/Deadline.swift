import Foundation

extension ScreenrAPI {
  // Sends a request that gives up once `deadline` passes on `clock`, failing
  // as `.timedOut` with the request's ID.
  func send<Response>(
    _ request: APIRequest<Response>,
    within deadline: Duration,
    clock: any Clock<Duration>
  ) async -> Result<Response, APIError> {
    await withTaskGroup(of: DeadlineOutcome<Response>.self) { group in
      group.addTask {
        do throws(APIError) {
          return .response(.success(try await send(request)))
        } catch {
          return .response(.failure(error))
        }
      }
      group.addTask {
        do {
          try await clock.sleep(for: deadline)
          return .expired
        } catch {
          return .stopped
        }
      }
      var expired = false
      while let outcome = await group.next() {
        switch outcome {
        case .response(let result):
          group.cancelAll()
          guard expired, case .failure(let error) = result, error.kind == .cancelled else {
            return result
          }
          return .failure(APIError(kind: .timedOut, requestID: error.requestID))
        case .expired:
          expired = true
          group.cancelAll()
        case .stopped:
          continue
        }
      }
      return .failure(APIError(kind: .cancelled, requestID: ""))
    }
  }
}

private enum DeadlineOutcome<Response: Sendable>: Sendable {
  case response(Result<Response, APIError>)
  case expired
  case stopped
}
