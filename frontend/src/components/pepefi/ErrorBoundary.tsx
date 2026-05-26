import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { hasError: boolean; error?: Error }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6 text-center">
          <div className="text-5xl">⚠️</div>
          <h2 className="text-xl font-semibold text-white">Something went wrong</h2>
          <p className="text-sm text-gray-400 max-w-md">
            This page hit an unexpected error. Other pages should still work — try the navigation menu.
          </p>
          <details className="max-w-md text-left">
            <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400">Show details</summary>
            <pre className="mt-2 p-3 rounded bg-gray-900 border border-surface-border text-xs text-gray-500 overflow-x-auto">
              {this.state.error?.message ?? 'Unknown error'}
            </pre>
          </details>
          <button
            onClick={() => this.setState({ hasError: false, error: undefined })}
            className="px-4 py-2 rounded-lg bg-brand-200 hover:bg-brand-300 text-white text-sm font-semibold"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
