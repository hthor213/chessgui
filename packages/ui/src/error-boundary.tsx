"use client"

import React from "react"

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex flex-col items-center justify-center bg-[#0a0a0a] text-white gap-4">
          <h1 className="text-xl font-bold">Something went wrong</h1>
          <p className="text-sm text-zinc-400 max-w-md text-center">
            {this.state.error?.message}
          </p>
          <p className="text-xs text-zinc-500">
            Your game has been saved and will resume automatically.
          </p>
          <button
            className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-700"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
