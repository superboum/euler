(asdf:defsystem #:cellular-automaton
  :pathname "src"
  :serial t
  :depends-on (#:sdl2)
  :components ((:file "package")
               (:file "elementary")
               (:file "life")
               (:file "proxy")
               (:file "proxy-elementary")
               (:file "proxy-life")
               (:file "viz2")
))
